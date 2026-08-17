import { createDocument, type AudioDocument } from '../audio/AudioDocument';
import { measureFirstPlayLatency } from './firstPlayLatency';
import type { Clip, Session, Track } from './session';

// R4 (P2-7): deterministic pins for the first-play latency instrument. The
// fake world is driven ENTIRELY by the injected `now`/`tick` — each tick
// advances the fake clock by exactly 2 ms and fires scripted events at fixed
// tick indices — so every reported millisecond value is an exact expectation,
// not a range. An instrument whose own semantics (first-observation times,
// interleaved polling, timeout behaviour, context reuse) are not pinned
// cannot be trusted to measure anything.

// --- minimal fake Web Audio surface (MultitrackPlayer.test.ts's approach) ---

class FakeNode {
  connect(dest: unknown): unknown {
    return dest;
  }
  disconnect(): void {}
}

class FakeParam {
  value = 0;
  setTargetAtTime(value: number): void {
    this.value = value;
  }
}

class FakeGain extends FakeNode {
  gain = new FakeParam();
}

class FakeBuffer {
  constructor(
    public numberOfChannels: number,
    public length: number,
    public sampleRate: number
  ) {}
  copyToChannel(): void {}
}

class FakeSource extends FakeNode {
  buffer: FakeBuffer | null = null;
  onended: (() => void) | null = null;
  start(): void {}
  stop(): void {}
}

class FakeAudioContext {
  currentTime = 0;
  sampleRate = 1000;
  state = 'suspended';
  destination = new FakeNode();
  resumeCalls = 0;
  closed = false;
  createBuffer(ch: number, len: number, sr: number): FakeBuffer {
    return new FakeBuffer(ch, len, sr);
  }
  createBufferSource(): FakeSource {
    return new FakeSource();
  }
  createGain(): FakeGain {
    return new FakeGain();
  }
  createChannelMerger(): FakeNode {
    return new FakeNode();
  }
  createChannelSplitter(): FakeNode {
    return new FakeNode();
  }
  resume(): Promise<void> {
    this.resumeCalls++;
    return Promise.resolve();
  }
  close(): Promise<void> {
    this.closed = true;
    return Promise.resolve();
  }
  baseLatency = 0.005; // 5 ms
  outputLatency = 0.02; // 20 ms
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
function sessionOf(tracks: Track[], sampleRate = 1000): Session {
  return { name: 'S', sampleRate, tracks };
}
function doc(id: string, length = 2000, sampleRate = 1000): AudioDocument {
  const d = createDocument({ name: id, sampleRate, channels: [new Float32Array(length).fill(0.5)] });
  return { ...d, id };
}

/** A session with one track and one 2 s clip at 0 — always schedulable. */
function playableSession(): { session: Session; docs: Map<string, AudioDocument> } {
  const d = doc('doc-1');
  return {
    session: sessionOf([track({ clips: [clip({ documentId: 'doc-1', lengthSample: 2000 })] })]),
    docs: new Map([[d.id, d]]),
  };
}

/**
 * A scripted fake world: `now()` reads the fake clock; each `tick()` advances
 * it by exactly 2 ms, then fires the event scripted for that (1-based,
 * global across probes) tick index.
 */
function fakeWorld(events: Map<number, (ctx: FakeAudioContext) => void>, ctx: FakeAudioContext) {
  let fakeNow = 0;
  let tickIndex = 0;
  return {
    now: () => fakeNow,
    tick: async () => {
      fakeNow += 2;
      tickIndex++;
      events.get(tickIndex)?.(ctx);
    },
  };
}

describe('measureFirstPlayLatency', () => {
  it('reports exact first-observation times for running/clock/position, per probe', async () => {
    const ctx = new FakeAudioContext();
    // COLD: running on tick 2 (observed at t=4), clock+position on tick 5
    // (observed at t=10). WARM (starts at t=10 after the cold probe's 5
    // ticks): running is immediate (already 'running', observed at +0),
    // clock bump on global tick 8 (observed at warm t=+6).
    const events = new Map<number, (c: FakeAudioContext) => void>([
      [2, (c) => void (c.state = 'running')],
      [5, (c) => void (c.currentTime += 0.05)],
      [8, (c) => void (c.currentTime += 0.05)],
    ]);
    const { now, tick } = fakeWorld(events, ctx);
    const { session, docs } = playableSession();

    const report = await measureFirstPlayLatency(
      session,
      docs,
      () => ctx as unknown as AudioContext,
      now,
      tick,
      5000
    );

    expect(report.ok).toBe(true);
    expect(report.reason).toBeNull();

    const cold = report.cold;
    expect(cold).not.toBeNull();
    expect(cold?.initialCtxState).toBe('suspended');
    expect(cold?.playCallMs).toBe(0); // fake clock does not move inside play()
    expect(cold?.timeToRunningMs).toBe(4);
    expect(cold?.timeToClockAdvanceMs).toBe(10);
    expect(cold?.timeToPositionAdvanceMs).toBe(10);
    expect(cold?.baseLatencyMs).toBe(5);
    expect(cold?.outputLatencyMs).toBe(20);
    expect(cold?.audibleEstimateMs).toBe(30); // clockAdvance 10 + outputLatency 20
    expect(cold?.timedOut).toEqual([]);

    const warm = report.warm;
    expect(warm).not.toBeNull();
    // The warm probe must NOT create a second context...
    expect(warm?.ctxCreateMs).toBeNull();
    expect(warm?.initialCtxState).toBeNull();
    // ...and its pipeline is already hot: running observed immediately.
    expect(warm?.timeToRunningMs).toBe(0);
    expect(warm?.timeToClockAdvanceMs).toBe(6);
    expect(warm?.timeToPositionAdvanceMs).toBe(6);
    expect(warm?.timedOut).toEqual([]);

    // dispose() ran: the context was closed.
    expect(ctx.closed).toBe(true);
  });

  it('measures the context construction cost on the cold probe only', async () => {
    const ctx = new FakeAudioContext();
    ctx.state = 'running';
    const events = new Map<number, (c: FakeAudioContext) => void>([
      [1, (c) => void (c.currentTime += 0.05)],
      [3, (c) => void (c.currentTime += 0.05)],
    ]);
    const world = fakeWorld(events, ctx);
    const { session, docs } = playableSession();

    // Wrap now() so the factory can burn fake time during construction.
    let fakeNowOffset = 0;
    const now = () => world.now() + fakeNowOffset;
    const report = await measureFirstPlayLatency(
      session,
      docs,
      () => {
        fakeNowOffset += 3; // construction takes exactly 3 ms of fake time
        return ctx as unknown as AudioContext;
      },
      now,
      world.tick,
      5000
    );

    expect(report.ok).toBe(true);
    expect(report.cold?.ctxCreateMs).toBe(3);
    expect(report.warm?.ctxCreateMs).toBeNull(); // context reused, not rebuilt
  });

  it('a condition that never happens reports null, is named in timedOut, and still stops the player', async () => {
    const ctx = new FakeAudioContext(); // stays 'suspended', clock never moves
    const events = new Map<number, (c: FakeAudioContext) => void>();
    const { now, tick } = fakeWorld(events, ctx);
    const { session, docs } = playableSession();

    const report = await measureFirstPlayLatency(
      session,
      docs,
      () => ctx as unknown as AudioContext,
      now,
      tick,
      10 // 5 ticks of fake time, then give up
    );

    expect(report.ok).toBe(true); // the measurement ran; the numbers are honest nulls
    expect(report.cold?.timeToRunningMs).toBeNull();
    expect(report.cold?.timeToClockAdvanceMs).toBeNull();
    expect(report.cold?.timeToPositionAdvanceMs).toBeNull();
    expect(report.cold?.audibleEstimateMs).toBeNull();
    expect(report.cold?.timedOut).toEqual(['running', 'clockAdvance', 'positionAdvance']);
    expect(ctx.closed).toBe(true); // disposed on the way out
  });

  it('an unschedulable session fails honestly instead of reporting numbers', async () => {
    const ctx = new FakeAudioContext();
    const { now, tick } = fakeWorld(new Map(), ctx);
    const report = await measureFirstPlayLatency(
      sessionOf([track()]), // no clips
      new Map(),
      () => ctx as unknown as AudioContext,
      now,
      tick,
      5000
    );
    expect(report.ok).toBe(false);
    expect(report.reason).toMatch(/did not start/);
    expect(report.cold).toBeNull();
    expect(report.warm).toBeNull();
  });
});
