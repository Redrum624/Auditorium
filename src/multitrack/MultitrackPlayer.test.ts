import { createDocument, type AudioDocument } from '../audio/AudioDocument';
import { monoPanGains, stereoBalanceGains } from './mixdown';
import { MultitrackPlayer, SCHEDULE_LEAD } from './MultitrackPlayer';
import type { Clip, Session, Track } from './session';

// ---------------------------------------------------------------------------
// Minimal fake Web Audio graph (mirrors PlaybackEngine.test's approach). Only
// the surface MultitrackPlayer touches is modelled; currentTime is advanced
// manually so scheduling and position math are deterministic. The player now
// builds a manual per-channel gain graph (no StereoPannerNode) and ramps track
// params live via `AudioParam.setTargetAtTime`, so the fakes model splitters,
// mergers, and a recording `setTargetAtTime`.
// ---------------------------------------------------------------------------

interface Connection {
  dest: unknown;
  output?: number;
  input?: number;
}

class FakeNode {
  connections: Connection[] = [];
  disconnected = false;
  connect(dest: unknown, output?: number, input?: number): unknown {
    this.connections.push({ dest, output, input });
    return dest;
  }
  disconnect(): void {
    this.disconnected = true;
  }
}

interface TargetCall {
  value: number;
  startTime: number;
  timeConstant: number;
}

class FakeParam {
  value = 0;
  targetCalls: TargetCall[] = [];
  setTargetAtTime(value: number, startTime: number, timeConstant: number): void {
    this.targetCalls.push({ value, startTime, timeConstant });
    this.value = value; // reflect the target for convenience
  }
}

class FakeGain extends FakeNode {
  gain = new FakeParam();
}

class FakeSplitter extends FakeNode {
  constructor(public channels: number) {
    super();
  }
}

class FakeMerger extends FakeNode {
  constructor(public channels: number) {
    super();
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
  /** A fresh context is 'suspended' (frozen clock — the cold-play and
   * offline-render condition); the warm epoch tests flip it to 'running',
   * the only state whose clock advances under play()'s feet. */
  state = 'suspended';
  /** Seconds the clock advances on EVERY `currentTime` read. 0 keeps the
   * legacy frozen-clock behaviour (cold context); the epoch tests set it to
   * simulate a WARM context whose clock keeps running while play() bakes
   * buffers — the condition under which per-clip clock reads drift. */
  advancePerRead = 0;
  private clock = 0;
  get currentTime(): number {
    const t = this.clock;
    this.clock += this.advancePerRead;
    return t;
  }
  sampleRate = 1000;
  destination = new FakeNode();
  sources: FakeSource[] = [];
  gains: FakeGain[] = [];
  splitters: FakeSplitter[] = [];
  mergers: FakeMerger[] = [];
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
  createChannelSplitter(channels: number): FakeSplitter {
    const s = new FakeSplitter(channels);
    this.splitters.push(s);
    return s;
  }
  createChannelMerger(channels: number): FakeMerger {
    const m = new FakeMerger(channels);
    this.mergers.push(m);
    return m;
  }
  resume(): Promise<void> {
    return Promise.resolve();
  }
  close(): Promise<void> {
    return Promise.resolve();
  }
  advance(seconds: number): void {
    this.clock += seconds;
  }
}

function makePlayer(): { player: MultitrackPlayer; ctx: FakeAudioContext } {
  const ctx = new FakeAudioContext();
  const player = new MultitrackPlayer({ createContext: () => ctx as unknown as AudioContext });
  return { player, ctx };
}

/** Last element of an array (avoids relying on Array.prototype.at lib target). */
function last<T>(arr: T[]): T {
  return arr[arr.length - 1];
}

/** Reads a live track's node as a FakeGain (they are FakeGain under the fake ctx). */
function gainOf(player: MultitrackPlayer, trackId: string, key: 'volumeGain' | 'muteGain'): FakeGain {
  const nodes = player.liveTrackNodes(trackId);
  if (!nodes) throw new Error(`no live nodes for ${trackId}`);
  return nodes[key] as unknown as FakeGain;
}

/** Reads a clip's live pan pair as FakeGains (per-clip pan topology). */
function clipPanOf(
  player: MultitrackPlayer,
  trackId: string,
  clipId: string
): { panL: FakeGain; panR: FakeGain; mode: 'mono' | 'stereo' } {
  const nodes = player.liveTrackNodes(trackId);
  const pans = nodes?.clipPans.get(clipId);
  if (!pans) throw new Error(`no live pan nodes for ${trackId}/${clipId}`);
  return {
    panL: pans.panL as unknown as FakeGain,
    panR: pans.panR as unknown as FakeGain,
    mode: pans.mode,
  };
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

function stereoDoc(id: string, length = 2000, sampleRate = 1000): AudioDocument {
  const d = createDocument({
    name: id,
    sampleRate,
    channels: [new Float32Array(length).fill(0.5), new Float32Array(length).fill(-0.5)],
  });
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
    expect(call.when).toBeCloseTo(0.5, 6); // (500 - 0) / 1000 — suspended clock: no lead
    expect(call.offset).toBeCloseTo(0, 6);
    expect(call.duration).toBeCloseTo(0.5, 6); // (1000 - 500) / 1000
  });

  it('starts a clip mid-way when fromSample is inside it', () => {
    const { player, ctx } = makePlayer();
    const s = session([track({ clips: [clip({ documentId: 'doc-1', startSample: 500, lengthSample: 500 })] })]);
    player.play(700, s, docs(doc('doc-1')));

    const call = ctx.sources[0].startCalls[0];
    expect(call.when).toBeCloseTo(0, 6); // starts immediately — suspended clock: no lead
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

  it('builds EVERY track and gates a muted track via its muteGain (0)', () => {
    const { player, ctx } = makePlayer();
    const s = session([
      track({ id: 'A', muted: true, clips: [clip({ documentId: 'doc-1', startSample: 0, lengthSample: 500 })] }),
      track({ id: 'B', clips: [clip({ documentId: 'doc-1', startSample: 0, lengthSample: 500 })] }),
    ]);
    player.play(0, s, docs(doc('doc-1')));

    // Both tracks are now built (so mute can be lifted live) — both scheduled.
    expect(ctx.sources).toHaveLength(2);
    expect(gainOf(player, 'A', 'muteGain').gain.value).toBe(0); // muted → silent
    expect(gainOf(player, 'B', 'muteGain').gain.value).toBe(1);
  });

  it('gates non-soloed tracks via muteGain when any track is soloed', () => {
    const { player, ctx } = makePlayer();
    const s = session([
      track({ id: 'A', solo: true, clips: [clip({ documentId: 'doc-1', startSample: 0, lengthSample: 500 })] }),
      track({ id: 'B', clips: [clip({ documentId: 'doc-1', startSample: 0, lengthSample: 500 })] }),
    ]);
    player.play(0, s, docs(doc('doc-1')));

    expect(ctx.sources).toHaveLength(2);
    expect(gainOf(player, 'A', 'muteGain').gain.value).toBe(1); // soloed → audible
    expect(gainOf(player, 'B', 'muteGain').gain.value).toBe(0); // not soloed → silent
  });

  it('sets the track volume gain from volumeDb at build', () => {
    const { player } = makePlayer();
    const s = session([
      track({ id: 'T', volumeDb: -6, clips: [clip({ documentId: 'doc-1', startSample: 0, lengthSample: 500 })] }),
    ]);
    player.play(0, s, docs(doc('doc-1')));
    expect(gainOf(player, 'T', 'volumeGain').gain.value).toBeCloseTo(Math.pow(10, -6 / 20), 6);
  });

  it('builds a mono clip pan pair whose gains equal mixdown monoPanGains', () => {
    for (const pan of [-1, -0.5, 0, 0.5, 1]) {
      const { player } = makePlayer();
      const c = clip({ documentId: 'doc-1', startSample: 0, lengthSample: 500 });
      player.play(0, session([track({ id: 'T', pan, clips: [c] })]), docs(doc('doc-1'))); // mono source

      const { gL, gR } = monoPanGains(pan);
      const pans = clipPanOf(player, 'T', c.id);
      expect(pans.mode).toBe('mono');
      expect(pans.panL.gain.value).toBeCloseTo(gL, 6);
      expect(pans.panR.gain.value).toBeCloseTo(gR, 6);
      player.stop();
    }
  });

  it('builds a stereo clip pan pair whose gains equal mixdown stereoBalanceGains', () => {
    for (const pan of [-1, -0.5, 0, 0.5, 1]) {
      const { player } = makePlayer();
      const c = clip({ documentId: 'doc-2', startSample: 0, lengthSample: 500 });
      player.play(0, session([track({ id: 'T', pan, clips: [c] })]), docs(stereoDoc('doc-2'))); // stereo source

      const { gL, gR } = stereoBalanceGains(pan);
      const pans = clipPanOf(player, 'T', c.id);
      expect(pans.mode).toBe('stereo');
      expect(pans.panL.gain.value).toBeCloseTo(gL, 6);
      expect(pans.panR.gain.value).toBeCloseTo(gR, 6);
      player.stop();
    }
  });

  it('applies each law per CLIP on a mixed mono+stereo track (mixdown parity)', () => {
    // Discriminator for the per-clip topology: with one mono and one stereo clip
    // on the SAME track, each clip's pan pair must follow its OWN law — a single
    // per-track pan pair cannot satisfy both (the laws differ by ~3 dB at center).
    const { player } = makePlayer();
    const monoClip = clip({ documentId: 'doc-1', startSample: 0, lengthSample: 500 });
    const stereoClip = clip({ documentId: 'doc-2', startSample: 500, lengthSample: 500 });
    const t = track({ id: 'T', pan: 0.5, clips: [monoClip, stereoClip] });
    player.play(0, session([t]), docs(doc('doc-1'), stereoDoc('doc-2')));

    const mono = clipPanOf(player, 'T', monoClip.id);
    const monoLaw = monoPanGains(0.5);
    expect(mono.mode).toBe('mono');
    expect(mono.panL.gain.value).toBeCloseTo(monoLaw.gL, 6);
    expect(mono.panR.gain.value).toBeCloseTo(monoLaw.gR, 6);

    const stereo = clipPanOf(player, 'T', stereoClip.id);
    const stereoLaw = stereoBalanceGains(0.5);
    expect(stereo.mode).toBe('stereo');
    expect(stereo.panL.gain.value).toBeCloseTo(stereoLaw.gL, 6);
    expect(stereo.panR.gain.value).toBeCloseTo(stereoLaw.gR, 6);

    // A live pan change keeps each clip under its own law.
    player.applyTrackParams([{ ...t, pan: -0.5 }]);
    const monoLaw2 = monoPanGains(-0.5);
    const stereoLaw2 = stereoBalanceGains(-0.5);
    expect(last(mono.panL.gain.targetCalls).value).toBeCloseTo(monoLaw2.gL, 6);
    expect(last(mono.panR.gain.targetCalls).value).toBeCloseTo(monoLaw2.gR, 6);
    expect(last(stereo.panL.gain.targetCalls).value).toBeCloseTo(stereoLaw2.gL, 6);
    expect(last(stereo.panR.gain.targetCalls).value).toBeCloseTo(stereoLaw2.gR, 6);
  });

  it('applies a live volume change without rebuilding the sources', () => {
    const { player, ctx } = makePlayer();
    const t = track({ id: 'T', volumeDb: 0, clips: [clip({ documentId: 'doc-1', startSample: 0, lengthSample: 1000 })] });
    player.play(0, session([t]), docs(doc('doc-1')));

    const sourceBefore = ctx.sources[0];
    const vol = gainOf(player, 'T', 'volumeGain');

    player.applyTrackParams([{ ...t, volumeDb: -6 }]);

    const call = last(vol.gain.targetCalls);
    expect(call.value).toBeCloseTo(Math.pow(10, -6 / 20), 6);
    expect(call.timeConstant).toBe(0.015);
    // Same source instance — the running graph was retuned, not rebuilt.
    expect(ctx.sources).toHaveLength(1);
    expect(ctx.sources[0]).toBe(sourceBefore);
  });

  it('applies a live pan change through the same clip pan nodes (mono law)', () => {
    const { player } = makePlayer();
    const c = clip({ documentId: 'doc-1', startSample: 0, lengthSample: 1000 });
    const t = track({ id: 'T', pan: 0, clips: [c] });
    player.play(0, session([t]), docs(doc('doc-1')));

    const { panL, panR } = clipPanOf(player, 'T', c.id);
    player.applyTrackParams([{ ...t, pan: 0.5 }]);

    const { gL, gR } = monoPanGains(0.5);
    expect(last(panL.gain.targetCalls).value).toBeCloseTo(gL, 6);
    expect(last(panR.gain.targetCalls).value).toBeCloseTo(gR, 6);
    expect(last(panL.gain.targetCalls).timeConstant).toBe(0.015);
  });

  it('applies live solo/un-solo/mute via muteGain (mute wins on a soloed track)', () => {
    const { player } = makePlayer();
    const a = track({ id: 'A', clips: [clip({ documentId: 'doc-1', startSample: 0, lengthSample: 1000 })] });
    const b = track({ id: 'B', clips: [clip({ documentId: 'doc-1', startSample: 0, lengthSample: 1000 })] });
    player.play(0, session([a, b]), docs(doc('doc-1')));

    const aMute = gainOf(player, 'A', 'muteGain');
    const bMute = gainOf(player, 'B', 'muteGain');

    // Solo A → B silent, A audible.
    player.applyTrackParams([{ ...a, solo: true }, b]);
    expect(last(bMute.gain.targetCalls).value).toBe(0);
    expect(last(aMute.gain.targetCalls).value).toBe(1);

    // Un-solo → both audible.
    player.applyTrackParams([a, b]);
    expect(last(bMute.gain.targetCalls).value).toBe(1);
    expect(last(aMute.gain.targetCalls).value).toBe(1);

    // Mute wins even on the soloed track.
    player.applyTrackParams([{ ...a, solo: true, muted: true }, b]);
    expect(last(aMute.gain.targetCalls).value).toBe(0);
  });

  it('ignores applyTrackParams when stopped', () => {
    const { player } = makePlayer();
    const t = track({ id: 'T', clips: [clip({ documentId: 'doc-1', startSample: 0, lengthSample: 500 })] });
    player.play(0, session([t]), docs(doc('doc-1')));
    player.stop();
    // No live nodes remain and the call is a safe no-op.
    expect(player.liveTrackNodes('T')).toBeUndefined();
    expect(() => player.applyTrackParams([{ ...t, volumeDb: -12 }])).not.toThrow();
  });

  it('derives position from ctx.currentTime and the session rate, clamped to the end', () => {
    const { player, ctx } = makePlayer();
    const s = session([track({ clips: [clip({ documentId: 'doc-1', startSample: 0, lengthSample: 1000 })] })]);
    player.play(200, s, docs(doc('doc-1')));
    ctx.advance(0.3); // 300 samples at 1000 Hz (suspended clock: epoch = play time, no lead)
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

  describe('shared scheduling epoch (all tracks scheduled against ONE clock read)', () => {
    // The user-reported bug: on a WARM (running, never-suspended) context the
    // clock keeps advancing while play() synchronously bakes each track's
    // buffers. Reading ctx.currentTime per clip AFTER each track's bake gives
    // every track its own timeline origin, shifted by the JS time spent since
    // the previous track's start commands — one track plays tens of ms early
    // against the others while the screen shows everything correctly placed.
    // The fake advances the clock on EVERY read to simulate the warm clock;
    // correctness is that inter-clip start-time deltas equal their
    // startSample deltas no matter how the clock moved between reads.

    /** 3 tracks, 4 clips; play(100) enters a1/b1 mid-clip (a co-started pair
     * on DIFFERENT tracks), c1 and b2 are future clips. Effective timeline
     * starts (max(from, startSample)): a1=100, b1=100, b2=2500, c1=400. */
    function threeTrackSession(): Session {
      return session([
        track({ id: 'A', clips: [clip({ documentId: 'doc-1', startSample: 0, lengthSample: 2000 })] }),
        track({
          id: 'B',
          clips: [
            clip({ documentId: 'doc-1', startSample: 0, lengthSample: 2000 }),
            clip({ documentId: 'doc-1', startSample: 2500, lengthSample: 500 }),
          ],
        }),
        track({ id: 'C', clips: [clip({ documentId: 'doc-1', startSample: 400, lengthSample: 1000 })] }),
      ]);
    }

    it('keeps every pair of start times exactly startSample-delta apart on a warm advancing clock', () => {
      const { player, ctx } = makePlayer();
      ctx.state = 'running'; // warm context
      ctx.advancePerRead = 0.03; // 30 ms of warm clock pass on every read
      player.play(100, threeTrackSession(), docs(doc('doc-1')));

      expect(ctx.sources).toHaveLength(4);
      const whens = ctx.sources.map((s) => s.startCalls[0].when);
      // Sources are created in session order: A.a1, B.b1, B.b2, C.c1.
      const effStart = [100, 100, 2500, 400];

      // The epoch read is the FIRST clock read play() performs (any earlier
      // read would burn a 30 ms tick and shift every start), so a play-start
      // clip's `when` is exactly read-value 0 + the running-clock lead.
      expect(whens[0]).toBe(SCHEDULE_LEAD);

      // The co-started pair on different tracks: bit-identical start times.
      expect(whens[1]).toBe(whens[0]);

      // Every pair's start-time delta, expressed in samples, equals its
      // effective-start delta. Precision 6 (≪ one sample; double rounding
      // noise only) — the per-clip clock reads would drift these by
      // 30 samples per read.
      for (let i = 0; i < whens.length; i++) {
        for (let j = i + 1; j < whens.length; j++) {
          expect((whens[j] - whens[i]) * 1000).toBeCloseTo(effStart[j] - effStart[i], 6);
        }
      }

      // The intra-clip offset/duration math is untouched by the epoch.
      expect(ctx.sources[0].startCalls[0].offset).toBeCloseTo(0.1, 6); // (100-0)/1000
      expect(ctx.sources[0].startCalls[0].duration).toBeCloseTo(1.9, 6);
      expect(ctx.sources[3].startCalls[0].offset).toBeCloseTo(0, 6);
      expect(ctx.sources[3].startCalls[0].duration).toBeCloseTo(1.0, 6);
    });

    it('anchors the playhead to the same epoch the sources were scheduled against', () => {
      const { player, ctx } = makePlayer();
      ctx.state = 'running';
      ctx.advancePerRead = 0.03;
      player.play(100, threeTrackSession(), docs(doc('doc-1')));
      ctx.advancePerRead = 0; // freeze the clock for a stable readback

      // A clip entering AT the play position starts exactly at the epoch, so
      // its `when` IS the epoch. The visual playhead must map time→samples
      // against that same anchor: pos = from + (now − epoch)·rate.
      const epoch = ctx.sources[0].startCalls[0].when;
      const now = ctx.currentTime;
      expect(player.getPositionSample()).toBeCloseTo(100 + (now - epoch) * 1000, 6);
    });

    it('holds the playhead at the play start while the schedule lead has not elapsed', () => {
      const { player, ctx } = makePlayer();
      ctx.state = 'running'; // running context: the lead applies
      const s = session([track({ clips: [clip({ documentId: 'doc-1', startSample: 0, lengthSample: 1000 })] })]);
      player.play(200, s, docs(doc('doc-1')));
      // The epoch is SCHEDULE_LEAD ahead of the clock: no audio has advanced
      // yet, and the playhead must not sit BEFORE the cursor.
      expect(player.getPositionSample()).toBe(200);
    });

    it('applies the lead on a RUNNING clock: the first start sits SCHEDULE_LEAD ahead of the epoch read', () => {
      // The gate's RUNNING arm, pinned on PRODUCTION output (review round 2:
      // mutating schedulingEpoch to drop the lead entirely passed every
      // test; this one fails it — a lead-less warm start can be in the past
      // by drain time, and Web Audio clamping late starts to "now" displaces
      // entered-at-position clips against future-scheduled ones, the same
      // skew family P1 kills). Running state, frozen clock: the epoch read
      // returns 0, so a clip entering at the play position starts exactly at
      // the lead. Asserting the exported constant against the RAW captured
      // `when` is not round 1's compensation sin — nothing here feeds a
      // renderer.
      const { player, ctx } = makePlayer();
      ctx.state = 'running';
      const s = session([track({ clips: [clip({ documentId: 'doc-1', startSample: 0, lengthSample: 1000 })] })]);
      player.play(100, s, docs(doc('doc-1')));
      expect(ctx.sources[0].startCalls[0].when).toBe(SCHEDULE_LEAD);
    });

    it('schedules a suspended (cold/offline) context with ZERO displacement — sample 0 at time 0', () => {
      // The packaged smoke renders this SAME play() into an
      // OfflineAudioContext and compares ABSOLUTELY against mixdownSession:
      // play-relative sample 0 must sound at render time 0. A suspended
      // clock cannot advance between the epoch read and the command drain,
      // so no lead is needed — and any lead displaces the ENTIRE render
      // against the timeline (measured as full-scale error outside the
      // crossfade overlap by the smoke's bit-identical assertion).
      const { player, ctx } = makePlayer(); // state stays 'suspended'
      const s = session([
        track({ clips: [clip({ documentId: 'doc-1', startSample: 0, lengthSample: 500 })] }),
        track({ clips: [clip({ documentId: 'doc-1', startSample: 250, lengthSample: 500 })] }),
      ]);
      player.play(0, s, docs(doc('doc-1')));
      expect(ctx.sources[0].startCalls[0].when).toBe(0); // exactly render time 0
      expect(ctx.sources[1].startCalls[0].when).toBeCloseTo(0.25, 6); // (250 - 0) / 1000
    });
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
