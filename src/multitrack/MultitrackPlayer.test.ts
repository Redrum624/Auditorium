import { createDocument, type AudioDocument } from '../audio/AudioDocument';
import { MultitrackPlayer } from './MultitrackPlayer';
import type { Clip, Session, Track } from './session';

// ---------------------------------------------------------------------------
// Minimal fake Web Audio graph (mirrors PlaybackEngine.test's approach). Only
// the surface MultitrackPlayer touches is modelled; currentTime is advanced
// manually so scheduling and position math are deterministic.
// ---------------------------------------------------------------------------

class FakeNode {
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

class FakeGain extends FakeNode {
  gain = { value: 0 };
}

class FakePanner extends FakeNode {
  pan = { value: 0 };
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
  onended: (() => void) | null = null;
  startCalls: StartCall[] = [];
  stopped = false;
  start(when = 0, offset?: number, duration?: number): void {
    this.startCalls.push({ when, offset, duration });
  }
  stop(): void {
    if (this.stopped) throw new Error('already stopped');
    this.stopped = true;
    this.onended?.();
  }
  fireEnded(): void {
    this.onended?.();
  }
}

class FakeAudioContext {
  currentTime = 0;
  sampleRate = 1000;
  destination = new FakeNode();
  sources: FakeSource[] = [];
  gains: FakeGain[] = [];
  panners: FakePanner[] = [];
  createBuffer(ch: number, len: number, sr: number): FakeBuffer {
    return new FakeBuffer(ch, len, sr);
  }
  createBufferSource(): FakeSource {
    const s = new FakeSource();
    this.sources.push(s);
    return s;
  }
  createGain(): FakeGain {
    const g = new FakeGain();
    this.gains.push(g);
    return g;
  }
  createStereoPanner(): FakePanner {
    const p = new FakePanner();
    this.panners.push(p);
    return p;
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

function makePlayer(): { player: MultitrackPlayer; ctx: FakeAudioContext } {
  const ctx = new FakeAudioContext();
  const player = new MultitrackPlayer({ createContext: () => ctx as unknown as AudioContext });
  return { player, ctx };
}

let idSeq = 0;
function clip(partial: Partial<Clip> & { documentId: string }): Clip {
  return {
    id: `clip-${++idSeq}`,
    startSample: 0,
    offsetSample: 0,
    lengthSample: 0,
    gainDb: 0,
    ...partial,
  };
}
function track(partial: Partial<Track> = {}): Track {
  return {
    id: `track-${++idSeq}`,
    name: 'T',
    volumeDb: 0,
    pan: 0,
    muted: false,
    solo: false,
    armed: false,
    clips: [],
    ...partial,
  };
}
function session(tracks: Track[], sampleRate = 1000): Session {
  return { name: 'S', sampleRate, tracks };
}

function doc(id: string, length = 2000, sampleRate = 1000): AudioDocument {
  const d = createDocument({ name: id, sampleRate, channels: [new Float32Array(length).fill(0.5)] });
  return { ...d, id };
}

function docs(...ds: AudioDocument[]): Map<string, AudioDocument> {
  return new Map(ds.map((d) => [d.id, d]));
}

describe('MultitrackPlayer', () => {
  it('schedules a source for a future clip with when/offset/duration', () => {
    const { player, ctx } = makePlayer();
    const s = session([track({ clips: [clip({ documentId: 'doc-1', startSample: 500, lengthSample: 500 })] })]);
    player.play(0, s, docs(doc('doc-1')));

    expect(ctx.sources).toHaveLength(1);
    const call = ctx.sources[0].startCalls[0];
    expect(call.when).toBeCloseTo(0.5, 6); // (500 - 0) / 1000
    expect(call.offset).toBeCloseTo(0, 6);
    expect(call.duration).toBeCloseTo(0.5, 6); // (1000 - 500) / 1000
  });

  it('starts a clip mid-way when fromSample is inside it', () => {
    const { player, ctx } = makePlayer();
    const s = session([track({ clips: [clip({ documentId: 'doc-1', startSample: 500, lengthSample: 500 })] })]);
    player.play(700, s, docs(doc('doc-1')));

    const call = ctx.sources[0].startCalls[0];
    expect(call.when).toBeCloseTo(0, 6); // starts immediately
    expect(call.offset).toBeCloseTo(0.2, 6); // (700 - 500) / 1000
    expect(call.duration).toBeCloseTo(0.3, 6); // (1000 - 700) / 1000
  });

  it('skips clips that end at or before fromSample', () => {
    const { player, ctx } = makePlayer();
    const s = session([
      track({
        clips: [
          clip({ documentId: 'doc-1', startSample: 500, lengthSample: 500 }), // ends 1000
          clip({ documentId: 'doc-1', startSample: 1200, lengthSample: 500 }), // ends 1700
        ],
      }),
    ]);
    player.play(1500, s, docs(doc('doc-1')));

    expect(ctx.sources).toHaveLength(1); // only the 1200..1700 clip
    expect(ctx.sources[0].startCalls[0].offset).toBeCloseTo(0.3, 6); // (1500 - 1200)/1000
  });

  it('does not schedule muted-track clips; honors solo', () => {
    const muted = session([
      track({ muted: true, clips: [clip({ documentId: 'doc-1', startSample: 0, lengthSample: 500 })] }),
      track({ clips: [clip({ documentId: 'doc-1', startSample: 0, lengthSample: 500 })] }),
    ]);
    const p1 = makePlayer();
    p1.player.play(0, muted, docs(doc('doc-1')));
    expect(p1.ctx.sources).toHaveLength(1);

    const soloed = session([
      track({ solo: true, clips: [clip({ documentId: 'doc-1', startSample: 0, lengthSample: 500 })] }),
      track({ clips: [clip({ documentId: 'doc-1', startSample: 0, lengthSample: 500 })] }),
    ]);
    const p2 = makePlayer();
    p2.player.play(0, soloed, docs(doc('doc-1')));
    expect(p2.ctx.sources).toHaveLength(1);
  });

  it('sets the track gain (volume) and panner value per audible track', () => {
    const { player, ctx } = makePlayer();
    const s = session([
      track({ volumeDb: -6, pan: 0.5, clips: [clip({ documentId: 'doc-1', startSample: 0, lengthSample: 500 })] }),
    ]);
    player.play(0, s, docs(doc('doc-1')));

    // One track gain node built with 10^(-6/20); one panner at 0.5.
    expect(ctx.gains.some((g) => Math.abs(g.gain.value - Math.pow(10, -6 / 20)) < 1e-6)).toBe(true);
    expect(ctx.panners[0].pan.value).toBeCloseTo(0.5, 6);
  });

  it('derives position from ctx.currentTime and the session rate, clamped to the end', () => {
    const { player, ctx } = makePlayer();
    const s = session([track({ clips: [clip({ documentId: 'doc-1', startSample: 0, lengthSample: 1000 })] })]);
    player.play(200, s, docs(doc('doc-1')));
    ctx.advance(0.3); // 300 samples at 1000 Hz
    expect(player.getPositionSample()).toBe(500);

    ctx.advance(1.0); // would be 1500, clamped to end (1000)
    expect(player.getPositionSample()).toBe(1000);
  });

  it('stop() stops and disconnects every source and resets state/position', () => {
    const { player, ctx } = makePlayer();
    const states: string[] = [];
    player.onStateChange((st) => states.push(st));
    const s = session([track({ clips: [clip({ documentId: 'doc-1', startSample: 0, lengthSample: 500 })] })]);

    player.play(250, s, docs(doc('doc-1')));
    expect(player.state).toBe('playing');
    ctx.advance(0.1);
    player.stop();

    expect(player.state).toBe('stopped');
    for (const src of ctx.sources) {
      expect(src.stopped).toBe(true);
      expect(src.disconnected).toBe(true);
    }
    expect(player.getPositionSample()).toBe(250); // back to play-start
    expect(states).toEqual(['playing', 'stopped']);
  });

  it('emits a single stopped transition on natural end', () => {
    const { player, ctx } = makePlayer();
    const states: string[] = [];
    player.onStateChange((st) => states.push(st));
    const s = session([track({ clips: [clip({ documentId: 'doc-1', startSample: 0, lengthSample: 500 })] })]);

    player.play(0, s, docs(doc('doc-1')));
    ctx.sources[ctx.sources.length - 1].fireEnded();

    expect(player.state).toBe('stopped');
    expect(states).toEqual(['playing', 'stopped']);
  });

  it('no-ops safely when no AudioContext is available', () => {
    const player = new MultitrackPlayer({ createContext: () => null as unknown as AudioContext });
    const s = session([track({ clips: [clip({ documentId: 'doc-1', startSample: 0, lengthSample: 500 })] })]);
    expect(() => {
      player.play(0, s, docs(doc('doc-1')));
      player.stop();
    }).not.toThrow();
    expect(player.state).toBe('stopped');
  });
});
