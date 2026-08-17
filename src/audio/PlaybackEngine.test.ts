import { PlaybackEngine } from './PlaybackEngine';
import { createDocument, type AudioDocument } from './AudioDocument';

// ---------------------------------------------------------------------------
// Minimal fake Web Audio graph. Only the surface the engine touches is modelled.
// `currentTime` is advanced manually so position math is deterministic, and
// `FakeSource.fireEnded()` invokes the onended handler to simulate natural end.
// ---------------------------------------------------------------------------

class FakeNode {
  connections: unknown[] = [];
  connect(dest: unknown): unknown {
    this.connections.push(dest);
    return dest;
  }
  disconnect(): void {}
}

class FakeGain extends FakeNode {
  gain = { value: 0 };
}

class FakeSplitter extends FakeNode {}

class FakeAnalyser extends FakeNode {
  fftSize = 2048;
  private data: Float32Array | null = null;
  setData(d: Float32Array): void {
    this.data = d;
  }
  getFloatTimeDomainData(arr: Float32Array): void {
    if (this.data) arr.set(this.data.subarray(0, arr.length));
  }
}

class FakeBuffer {
  copied: Float32Array[] = [];
  constructor(
    public numberOfChannels: number,
    public length: number,
    public sampleRate: number
  ) {}
  copyToChannel(src: Float32Array, ch: number): void {
    this.copied[ch] = src;
  }
}

interface StartCall {
  when: number;
  offset?: number;
  duration?: number;
}

class FakeSource extends FakeNode {
  buffer: FakeBuffer | null = null;
  loop = false;
  loopStart = 0;
  loopEnd = 0;
  onended: (() => void) | null = null;
  startCalls: StartCall[] = [];
  stopped = false;
  start(when = 0, offset?: number, duration?: number): void {
    this.startCalls.push({ when, offset, duration });
  }
  stop(): void {
    if (this.stopped) throw new Error('already stopped');
    this.stopped = true;
    // Real Web Audio fires onended after a manual stop() too. Modelling that
    // faithfully is what proves the engine never mistakes a manual
    // stop/pause/load teardown for a natural end.
    this.onended?.();
  }
  fireEnded(): void {
    this.onended?.();
  }
}

class FakeAudioContext {
  currentTime = 0;
  sampleRate = 44100;
  destination = new FakeNode();
  sources: FakeSource[] = [];
  createdAnalysers: FakeAnalyser[] = [];
  createBuffer(ch: number, len: number, sr: number): FakeBuffer {
    return new FakeBuffer(ch, len, sr);
  }
  createBufferSource(): FakeSource {
    const s = new FakeSource();
    this.sources.push(s);
    return s;
  }
  createGain(): FakeGain {
    return new FakeGain();
  }
  createChannelSplitter(): FakeSplitter {
    return new FakeSplitter();
  }
  createAnalyser(): FakeAnalyser {
    const a = new FakeAnalyser();
    this.createdAnalysers.push(a);
    return a;
  }
  resume(): Promise<void> {
    return Promise.resolve();
  }
  close(): Promise<void> {
    return Promise.resolve();
  }
  advance(seconds: number): void {
    this.currentTime += seconds;
  }
}

function makeDoc(opts?: { sampleRate?: number; length?: number; channels?: number }): AudioDocument {
  const sampleRate = opts?.sampleRate ?? 1000;
  const length = opts?.length ?? 2000;
  const channelCount = opts?.channels ?? 2;
  const channels = Array.from({ length: channelCount }, () => new Float32Array(length));
  return createDocument({ name: 'clip.wav', sampleRate, channels });
}

function makeEngine(): { engine: PlaybackEngine; ctx: FakeAudioContext } {
  const ctx = new FakeAudioContext();
  const engine = new PlaybackEngine({
    createContext: () => ctx as unknown as AudioContext,
  });
  return { engine, ctx };
}

describe('PlaybackEngine', () => {
  describe('state transitions', () => {
    it('cycles stopped -> playing -> paused -> playing -> stopped', () => {
      const { engine } = makeEngine();
      engine.load(makeDoc());
      expect(engine.state).toBe('stopped');

      engine.play(0, {});
      expect(engine.state).toBe('playing');

      engine.pause();
      expect(engine.state).toBe('paused');

      engine.play(engine.getPositionSample(), {});
      expect(engine.state).toBe('playing');

      engine.stop();
      expect(engine.state).toBe('stopped');
    });
  });

  describe('position math', () => {
    it('derives position from ctx.currentTime and the document sample rate', () => {
      const { engine, ctx } = makeEngine();
      engine.load(makeDoc({ sampleRate: 1000, length: 2000 }));
      engine.play(100, {});
      ctx.advance(0.5); // 500 samples at 1000 Hz
      expect(engine.getPositionSample()).toBe(600);
    });

    it('returns the stored position while paused (currentTime keeps advancing)', () => {
      const { engine, ctx } = makeEngine();
      engine.load(makeDoc({ sampleRate: 1000 }));
      engine.play(100, {});
      ctx.advance(0.3);
      expect(engine.getPositionSample()).toBe(400);
      engine.pause();
      ctx.advance(0.9); // ignored while paused
      expect(engine.getPositionSample()).toBe(400);
    });
  });

  describe('looping', () => {
    it('sets source.loop with loopStart/loopEnd in seconds', () => {
      const { engine, ctx } = makeEngine();
      engine.load(makeDoc({ sampleRate: 1000, length: 2000 }));
      engine.play(200, { loopRegion: { start: 100, end: 300 } });
      const src = ctx.sources[ctx.sources.length - 1];
      expect(src.loop).toBe(true);
      expect(src.loopStart).toBeCloseTo(0.1, 6);
      expect(src.loopEnd).toBeCloseTo(0.3, 6);
    });

    it('folds the position back into the loop region', () => {
      const { engine, ctx } = makeEngine();
      engine.load(makeDoc({ sampleRate: 1000, length: 2000 }));
      engine.play(200, { loopRegion: { start: 100, end: 300 } });
      ctx.advance(0.35); // raw pos 550 -> fold into [100,300): (550-100)%200 + 100 = 150
      expect(engine.getPositionSample()).toBe(150);
    });

    it('starts at the region start when fromSample is outside the loop region', () => {
      const { engine, ctx } = makeEngine();
      engine.load(makeDoc({ sampleRate: 1000, length: 2000 }));
      engine.play(500, { loopRegion: { start: 100, end: 300 } });
      const src = ctx.sources[ctx.sources.length - 1];
      expect(src.startCalls[0].offset).toBeCloseTo(0.1, 6);
    });
  });

  describe('natural end', () => {
    it('goes to stopped and resets position to the play-start sample', () => {
      const { engine, ctx } = makeEngine();
      const states: string[] = [];
      engine.onStateChange((s) => states.push(s));
      engine.load(makeDoc({ sampleRate: 1000 }));
      engine.play(300, {});
      const src = ctx.sources[ctx.sources.length - 1];
      src.fireEnded();
      expect(engine.state).toBe('stopped');
      expect(engine.getPositionSample()).toBe(300);
      expect(states).toContain('stopped');
    });
  });

  describe('load while playing', () => {
    it('stops the current source before rebuilding the buffer', () => {
      const { engine, ctx } = makeEngine();
      engine.load(makeDoc());
      engine.play(0, {});
      const first = ctx.sources[ctx.sources.length - 1];
      engine.load(makeDoc());
      expect(first.stopped).toBe(true);
      expect(engine.state).toBe('stopped');
    });
  });

  describe('pause / resume', () => {
    it('resumes from the paused sample offset', () => {
      const { engine, ctx } = makeEngine();
      engine.load(makeDoc({ sampleRate: 1000 }));
      engine.play(100, {});
      ctx.advance(0.3); // pos 400
      engine.pause();
      engine.play(engine.getPositionSample(), {});
      const src = ctx.sources[ctx.sources.length - 1];
      expect(src.startCalls[0].offset).toBeCloseTo(0.4, 6);
    });
  });

  describe('stop', () => {
    it('resets the position to the sample play last started from', () => {
      const { engine, ctx } = makeEngine();
      engine.load(makeDoc({ sampleRate: 1000 }));
      engine.play(250, {});
      ctx.advance(0.4);
      engine.stop();
      expect(engine.getPositionSample()).toBe(250);
    });
  });

  describe('selection-bounded play', () => {
    it('passes the region duration to source.start and stops at the region start', () => {
      const { engine, ctx } = makeEngine();
      engine.load(makeDoc({ sampleRate: 1000, length: 2000 }));
      engine.play(100, { playRegion: { start: 100, end: 600 } });
      const src = ctx.sources[ctx.sources.length - 1];
      expect(src.startCalls[0].offset).toBeCloseTo(0.1, 6);
      expect(src.startCalls[0].duration).toBeCloseTo(0.5, 6);

      src.fireEnded();
      expect(engine.state).toBe('stopped');
      expect(engine.getPositionSample()).toBe(100);
    });
  });

  describe('level metering', () => {
    beforeEach(() => jest.useFakeTimers());
    afterEach(() => jest.useRealTimers());

    it('emits per-channel peak dB from the analysers while playing', () => {
      const { engine, ctx } = makeEngine();
      engine.load(makeDoc({ sampleRate: 1000, channels: 2 }));
      // Two analysers were created (one per channel); feed known waveforms.
      ctx.createdAnalysers[0].setData(new Float32Array(2048).fill(0.5)); // -6.02 dB
      ctx.createdAnalysers[1].setData(new Float32Array(2048).fill(1.0)); //  0.00 dB
      const received: number[][] = [];
      engine.onLevel((peaks) => received.push(peaks));

      engine.play(0, {});
      jest.advanceTimersByTime(40); // one 33ms interval tick

      expect(received.length).toBeGreaterThan(0);
      const last = received[received.length - 1];
      expect(last).toHaveLength(2);
      expect(last[0]).toBeCloseTo(-6.02, 1);
      expect(last[1]).toBeCloseTo(0, 1);
    });

    it('clamps silence to -60 dB', () => {
      const { engine, ctx } = makeEngine();
      engine.load(makeDoc({ sampleRate: 1000, channels: 1 }));
      ctx.createdAnalysers[0].setData(new Float32Array(2048)); // all zeros
      const received: number[][] = [];
      engine.onLevel((peaks) => received.push(peaks));

      engine.play(0, {});
      jest.advanceTimersByTime(40);

      expect(received[received.length - 1]).toEqual([-60]);
    });

    it('stops emitting levels after playback stops', () => {
      const { engine, ctx } = makeEngine();
      engine.load(makeDoc({ channels: 1 }));
      ctx.createdAnalysers[0].setData(new Float32Array(2048).fill(0.5));
      const received: number[][] = [];
      engine.onLevel((peaks) => received.push(peaks));

      engine.play(0, {});
      jest.advanceTimersByTime(40);
      const count = received.length;
      engine.stop();
      jest.advanceTimersByTime(200);
      expect(received.length).toBe(count);
    });
  });

  describe('manual teardown is never mistaken for natural end (stop() fires onended)', () => {
    it('pause() lands in paused with position preserved — no stopped transition', () => {
      const { engine, ctx } = makeEngine();
      engine.load(makeDoc({ sampleRate: 1000 }));
      const states: string[] = [];
      engine.onStateChange((s) => states.push(s));

      engine.play(100, {});
      ctx.advance(0.3); // pos 400
      engine.pause(); // source.stop() fires onended synchronously here

      expect(engine.state).toBe('paused');
      expect(engine.getPositionSample()).toBe(400); // not reset to play start
      expect(states).toEqual(['playing', 'paused']); // no 'stopped' snuck in
    });

    it('load() while playing emits a single stopped transition, not a natural end', () => {
      const { engine, ctx } = makeEngine();
      engine.load(makeDoc({ sampleRate: 1000 }));
      const states: string[] = [];
      engine.onStateChange((s) => states.push(s));

      engine.play(200, {});
      ctx.advance(0.1);
      engine.load(makeDoc({ sampleRate: 1000 })); // tears the old source down

      expect(engine.state).toBe('stopped');
      expect(states).toEqual(['playing', 'stopped']); // exactly one stop, no double-emit
    });

    it('manual stop() emits exactly one stopped transition', () => {
      const { engine, ctx } = makeEngine();
      engine.load(makeDoc({ sampleRate: 1000 }));
      const states: string[] = [];
      engine.onStateChange((s) => states.push(s));

      engine.play(250, {});
      ctx.advance(0.4);
      engine.stop(); // source.stop() fires onended; must not re-enter handleEnded

      expect(engine.state).toBe('stopped');
      expect(engine.getPositionSample()).toBe(250);
      expect(states).toEqual(['playing', 'stopped']);
    });
  });

  describe('unload (Task M9 / F16)', () => {
    it('reports the loaded document id via loadedDocumentId, cleared once unloaded', () => {
      const { engine } = makeEngine();
      expect(engine.loadedDocumentId).toBeNull();
      const doc = makeDoc();
      engine.load(doc);
      expect(engine.loadedDocumentId).toBe(doc.id);
      engine.unload();
      expect(engine.loadedDocumentId).toBeNull();
    });

    it('keeps the AudioContext across unload — ensureContext is not re-invoked on the next load', () => {
      const ctx = new FakeAudioContext();
      const createContext = jest.fn(() => ctx as unknown as AudioContext);
      const engine = new PlaybackEngine({ createContext });

      engine.load(makeDoc());
      expect(createContext).toHaveBeenCalledTimes(1);

      engine.unload();
      engine.load(makeDoc());
      expect(createContext).toHaveBeenCalledTimes(1); // still cached — never recreated
    });

    it('stops active playback and releases the buffer/meta so play() no-ops afterward', () => {
      const { engine, ctx } = makeEngine();
      engine.load(makeDoc({ sampleRate: 1000 }));
      engine.play(100, {});
      expect(engine.state).toBe('playing');

      engine.unload();

      expect(engine.state).toBe('stopped');
      const sourceCountBefore = ctx.sources.length;
      engine.play(0, {}); // buffer/meta were released -> no-op, no new source
      expect(engine.state).toBe('stopped');
      expect(ctx.sources.length).toBe(sourceCountBefore);
    });

    it('resets the reported position to 0', () => {
      const { engine, ctx } = makeEngine();
      engine.load(makeDoc({ sampleRate: 1000 }));
      engine.play(300, {});
      ctx.advance(0.2);

      engine.unload();

      expect(engine.getPositionSample()).toBe(0);
    });

    it('is safe to call when nothing was ever loaded', () => {
      const { engine } = makeEngine();
      expect(() => engine.unload()).not.toThrow();
      expect(engine.state).toBe('stopped');
    });
  });

  describe('no AudioContext available', () => {
    it('no-ops safely when the context cannot be created', () => {
      const engine = new PlaybackEngine({ createContext: () => null as unknown as AudioContext });
      expect(() => {
        engine.load(makeDoc());
        engine.play(0, {});
        engine.pause();
        engine.stop();
      }).not.toThrow();
      expect(engine.state).toBe('stopped');
    });
  });
});
