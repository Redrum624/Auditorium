import { createDocument, type AudioDocument } from '../audio/AudioDocument';
import { automationValueAt, type AutomationKey, type AutomationLane } from './automation';
import {
  autoPanGainsAt,
  autoSpatialGainsAt,
  autoVolumeGainAt,
  mixdownSession,
  monoPanGains,
} from './mixdown';
import { MultitrackPlayer } from './MultitrackPlayer';
import type { Clip, Session, Track } from './session';

// ---------------------------------------------------------------------------
// F0, player side: track automation BAKED into the clip buffers (ruling A),
// the neutralised live nodes (ruling B), the promoted 2-channel mono-pan
// buffer (ruling C), applyTrackParams' baked-param skip (trap T2), the
// mid-play per-track rebuild (ruling D), and the RULING parity proof for a
// MOVING automation region.
//
// The Fake* harness, the graph renderer and maxAbsDiff are duplicated from
// MultitrackPlayer.fades.test.ts (kept local on purpose: that suite's pins
// must not be touched to test this feature). See that file's header for why
// the test — not any fake node — performs the graph arithmetic, and for the
// two-tier tolerance rationale (exact where every live gain is exactly 1,
// <1e-6 where a non-unity node gain rounds at a different point).
// ---------------------------------------------------------------------------

interface Connection {
  dest: unknown;
  output?: number;
  input?: number;
}

class FakeNode {
  connections: Connection[] = [];
  connect(dest: unknown, output?: number, input?: number): unknown {
    this.connections.push({ dest, output, input });
    return dest;
  }
  disconnect(): void {
    // teardown paths are exercised but never re-asserted mid-render here
  }
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
    this.stopped = true;
  }
}

class FakeAudioContext {
  currentTime = 0;
  sampleRate = 1000;
  destination = new FakeNode();
  sources: FakeSource[] = [];
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
  createChannelSplitter(channels: number): FakeSplitter {
    return new FakeSplitter(channels);
  }
  createChannelMerger(channels: number): FakeMerger {
    return new FakeMerger(channels);
  }
  resume(): Promise<void> {
    return Promise.resolve();
  }
  close(): Promise<void> {
    return Promise.resolve();
  }
}

function makePlayer(): { player: MultitrackPlayer; ctx: FakeAudioContext } {
  const ctx = new FakeAudioContext();
  const player = new MultitrackPlayer({ createContext: () => ctx as unknown as AudioContext });
  return { player, ctx };
}

// --- graph renderer (verbatim shape from the fades suite) -------------------

interface Route {
  pan: FakeGain;
  bufCh: number;
  side: 0 | 1;
}

function sideOf(pan: FakeGain): 0 | 1 {
  return (pan.connections[0].input ?? 0) === 1 ? 1 : 0;
}

function routesOf(src: FakeSource): Route[] {
  const first = src.connections[0]?.dest;
  if (first instanceof FakeSplitter) {
    return first.connections.map((cn) => ({
      pan: cn.dest as FakeGain,
      bufCh: cn.output ?? 0,
      side: sideOf(cn.dest as FakeGain),
    }));
  }
  return src.connections.map((cn) => ({
    pan: cn.dest as FakeGain,
    bufCh: 0,
    side: sideOf(cn.dest as FakeGain),
  }));
}

function chainGain(pan: FakeGain): number {
  const merger = pan.connections[0].dest as FakeMerger;
  const volume = merger.connections[0].dest as FakeGain;
  const mute = volume.connections[0].dest as FakeGain;
  const master = mute.connections[0].dest as FakeGain;
  return pan.gain.value * volume.gain.value * mute.gain.value * master.gain.value;
}

function renderPlayerGraph(ctx: FakeAudioContext, sr: number, outLen: number): [Float64Array, Float64Array] {
  const out: [Float64Array, Float64Array] = [new Float64Array(outLen), new Float64Array(outLen)];
  for (const src of ctx.sources) {
    if (!src.buffer || src.startCalls.length === 0 || src.stopped) continue;
    const call = src.startCalls[0];
    // ABSOLUTE placement: play-relative sample 0 must sound at render time 0
    // — the axis the packaged smoke's real OfflineAudioContext render
    // measures. A scheduling displacement must land HERE as a shifted
    // render, never be compensated away (fix round 1's lesson).
    const pos0 = Math.round(call.when * sr);
    const off = Math.round((call.offset ?? 0) * sr);
    const n = Math.min(Math.round((call.duration ?? 0) * sr), src.buffer.length - off);
    for (const r of routesOf(src)) {
      const data = src.buffer.copied[r.bufCh];
      const g = chainGain(r.pan);
      const ch = out[r.side];
      for (let j = 0; j < n; j++) {
        const idx = pos0 + j;
        if (idx >= 0 && idx < outLen) ch[idx] += data[off + j] * g;
      }
    }
  }
  return out;
}

function maxAbsDiff(
  emu: Float64Array,
  mix: Float32Array,
  from: number,
  lo: number,
  hi: number
): number {
  let max = 0;
  for (let s = lo; s < hi; s++) {
    max = Math.max(max, Math.abs(Math.fround(emu[s - from]) - mix[s]));
  }
  return max;
}

// --- fixtures ---------------------------------------------------------------

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
function monoDoc(id: string, value: number, length = 2000): AudioDocument {
  const d = createDocument({ name: id, sampleRate: 1000, channels: [new Float32Array(length).fill(value)] });
  return { ...d, id };
}
function stereoDoc(id: string, l: number, r: number, length = 2000): AudioDocument {
  const d = createDocument({
    name: id,
    sampleRate: 1000,
    channels: [new Float32Array(length).fill(l), new Float32Array(length).fill(r)],
  });
  return { ...d, id };
}
function docs(...ds: AudioDocument[]): Map<string, AudioDocument> {
  return new Map(ds.map((d) => [d.id, d]));
}
function dbToLinear(db: number): number {
  return Math.pow(10, db / 20);
}
function volLane(keys: AutomationKey[]): AutomationLane {
  return { param: 'volumeDb', keys };
}
function panLane(keys: AutomationKey[]): AutomationLane {
  return { param: 'pan', keys };
}

describe('MultitrackPlayer automation baking (buffer contents and node neutrality)', () => {
  const vKeys: AutomationKey[] = [
    { positionSample: 250, value: -6, curve: 'equal-gain' },
    { positionSample: 600, value: 0 },
  ];

  it('bakes a volume lane per TIMELINE sample; the volume node is unity; static pan stays live', () => {
    const { player, ctx } = makePlayer();
    const t = track({
      volumeDb: 2, // static — overridden by the lane, must NOT be baked or pushed
      clips: [clip({ documentId: 'm', startSample: 200, lengthSample: 1000 })],
      automation: [volLane(vKeys)],
    });
    player.play(0, session([t]), docs(monoDoc('m', 0.5)));

    const data = ctx.sources[0].buffer?.copied[0];
    if (!data) throw new Error('no baked buffer');
    // Exact per-sample product, timeline-indexed (clip starts at 200, first
    // key at 250 — buffer index 50; a clip-local bake would ramp from 0).
    for (const i of [0, 49, 50, 51, 250, 400, 401, 999]) {
      expect(data[i]).toBe(Math.fround(0.5 * 1 * autoVolumeGainAt(vKeys, 200 + i) * 1 * 1));
    }
    // Hold before the first key: flat at −6 dB (law-derived anchor).
    expect(data[0]).toBeCloseTo(0.5 * dbToLinear(-6), 6);
    expect(data[49]).toBe(data[0]);
    // Neutralised volume node; static-pan node still carries the mono law.
    const nodes = player.liveTrackNodes(t.id);
    expect(nodes?.bakedVolume).toBe(true);
    expect(nodes?.bakedPan).toBe(false);
    expect(nodes?.volumeGain.gain.value).toBe(1);
    const pans = nodes?.clipPans.get(t.clips[0].id);
    expect(pans?.panL.gain.value).toBeCloseTo(monoPanGains(0).gL, 12);
    // Mono source with no pan lane keeps its 1-channel buffer + fan-out.
    expect(ctx.sources[0].buffer?.numberOfChannels).toBe(1);
  });

  it('bakes a pan lane on a MONO clip into a PROMOTED 2-channel buffer under the MONO law (ruling C)', () => {
    const pKeys: AutomationKey[] = [
      { positionSample: 300, value: -1, curve: 'equal-gain' },
      { positionSample: 1100, value: 1 },
    ];
    const { player, ctx } = makePlayer();
    const t = track({
      pan: 0.7, // static — overridden
      volumeDb: -2, // NOT automated: stays on the live node
      clips: [clip({ documentId: 'm', startSample: 100, lengthSample: 1400 })],
      automation: [panLane(pKeys)],
    });
    player.play(0, session([t]), docs(monoDoc('m', 0.5)));

    const buf = ctx.sources[0].buffer;
    if (!buf) throw new Error('no buffer');
    expect(buf.numberOfChannels).toBe(2); // promoted: one channel cannot carry gL and gR (T3)
    // Routed like a stereo buffer (splitter), but the LAW baked in is MONO
    // constant-power — at pan 0 (timeline 700) both sides are 0.7071·0.5,
    // where the stereo balance law would read 0.5.
    const i700 = 700 - 100;
    expect(buf.copied[0][i700]).toBeCloseTo(0.5 * Math.cos(Math.PI / 4), 6);
    expect(buf.copied[1][i700]).toBeCloseTo(0.5 * Math.sin(Math.PI / 4), 6);
    for (const i of [0, 200, 600, 1399]) {
      const p = autoPanGainsAt(pKeys, 100 + i, true);
      expect(buf.copied[0][i]).toBe(Math.fround(0.5 * 1 * 1 * p.gL * 1));
      expect(buf.copied[1][i]).toBe(Math.fround(0.5 * 1 * 1 * p.gR * 1));
    }
    // Pan pair neutralised; volume node still live with the static value.
    const nodes = player.liveTrackNodes(t.id);
    expect(nodes?.bakedPan).toBe(true);
    expect(nodes?.bakedVolume).toBe(false);
    const pans = nodes?.clipPans.get(t.clips[0].id);
    expect(pans?.panL.gain.value).toBe(1);
    expect(pans?.panR.gain.value).toBe(1);
    expect(pans?.mode).toBe('stereo'); // buffer routing, not the law
    expect(nodes?.volumeGain.gain.value).toBeCloseTo(dbToLinear(-2), 12);
  });

  it('a zero-key lane changes nothing: static nodes, untouched unity buffer (=== no automation)', () => {
    const { player, ctx } = makePlayer();
    const t = track({
      volumeDb: 3,
      pan: -0.5,
      clips: [clip({ documentId: 'm', startSample: 0, lengthSample: 500 })],
      automation: [volLane([]), panLane([])],
    });
    player.play(0, session([t]), docs(monoDoc('m', 0.5, 500)));

    const nodes = player.liveTrackNodes(t.id);
    expect(nodes?.bakedVolume).toBe(false);
    expect(nodes?.bakedPan).toBe(false);
    expect(nodes?.volumeGain.gain.value).toBeCloseTo(dbToLinear(3), 12);
    const data = ctx.sources[0].buffer?.copied[0];
    if (!data) throw new Error('no buffer');
    for (let i = 0; i < 500; i++) expect(data[i]).toBe(0.5); // untouched slice
    expect(ctx.sources[0].buffer?.numberOfChannels).toBe(1);
  });
});

describe('applyTrackParams skips baked parameters (trap T2)', () => {
  it('a static write cannot stomp a baked volume node; un-baked pan still applies', () => {
    const { player } = makePlayer();
    const t = track({
      volumeDb: 0,
      pan: 0,
      clips: [clip({ documentId: 'm', startSample: 0, lengthSample: 1000 })],
      automation: [volLane([{ positionSample: 0, value: -6 }])],
    });
    player.play(0, session([t]), docs(monoDoc('m', 0.5)));
    const nodes = player.liveTrackNodes(t.id);
    expect(nodes?.volumeGain.gain.value).toBe(1);

    // The Toolbar subscription fires with the STATIC field changed (the very
    // write pattern that used to stomp the node).
    player.applyTrackParams([{ ...t, volumeDb: 6, pan: 0.5 }]);

    expect(nodes?.volumeGain.gain.value).toBe(1); // baked: untouched
    const pans = nodes?.clipPans.get(t.clips[0].id);
    expect(pans?.panL.gain.value).toBeCloseTo(monoPanGains(0.5).gL, 12); // live pan applied
    expect(nodes?.muteGain.gain.value).toBe(1); // mute path still live
  });

  it('a baked pan pair is skipped while a live volume still applies; mute stays live on both', () => {
    const { player } = makePlayer();
    const t = track({
      volumeDb: 0,
      pan: 0,
      clips: [clip({ documentId: 'm', startSample: 0, lengthSample: 1000 })],
      automation: [panLane([{ positionSample: 0, value: 0.5 }])],
    });
    player.play(0, session([t]), docs(monoDoc('m', 0.5)));
    const nodes = player.liveTrackNodes(t.id);
    const pans = nodes?.clipPans.get(t.clips[0].id);
    expect(pans?.panL.gain.value).toBe(1);

    player.applyTrackParams([{ ...t, volumeDb: -3, pan: -0.9, muted: true }]);

    expect(pans?.panL.gain.value).toBe(1); // baked: untouched
    expect(pans?.panR.gain.value).toBe(1);
    expect(nodes?.volumeGain.gain.value).toBeCloseTo(dbToLinear(-3), 12);
    expect(nodes?.muteGain.gain.value).toBe(0);
  });
});

describe('refreshTracks (ruling D — rebuild ONE track in place, mid-play)', () => {
  function twoTrackFixture() {
    const t1 = track({ clips: [clip({ documentId: 'a', startSample: 0, lengthSample: 1000 })] });
    const t2 = track({ clips: [clip({ documentId: 'b', startSample: 0, lengthSample: 1500 })] });
    const d = docs(monoDoc('a', 0.5), monoDoc('b', 0.25));
    return { t1, t2, d };
  }

  it('no-ops while stopped', () => {
    const { player, ctx } = makePlayer();
    const { t1, t2, d } = twoTrackFixture();
    player.refreshTracks(session([t1, t2]), d, [t1.id]);
    expect(ctx.sources).toHaveLength(0);
  });

  it('rebuilds only the named track: new baked source, old one stopped, other track untouched', () => {
    const { player, ctx } = makePlayer();
    const { t1, t2, d } = twoTrackFixture();
    player.play(0, session([t1, t2]), d);
    expect(ctx.sources).toHaveLength(2);
    const [src1, src2] = ctx.sources;

    const vKeys: AutomationKey[] = [
      { positionSample: 0, value: -6, curve: 'equal-gain' },
      { positionSample: 1000, value: 0 },
    ];
    const t1b = { ...t1, automation: [volLane(vKeys)] };
    player.refreshTracks(session([t1b, t2]), d, [t1.id]);

    expect(src1.stopped).toBe(true); // old chain torn down
    expect(src2.stopped).toBe(false); // sibling untouched
    expect(ctx.sources).toHaveLength(3);
    const fresh = ctx.sources[2];
    const data = fresh.buffer?.copied[0];
    if (!data) throw new Error('no rebaked buffer');
    for (const i of [0, 250, 500, 999]) {
      expect(data[i]).toBe(Math.fround(0.5 * 1 * autoVolumeGainAt(vKeys, i) * 1 * 1));
    }
    const nodes = player.liveTrackNodes(t1.id);
    expect(nodes?.bakedVolume).toBe(true);
    expect(nodes?.volumeGain.gain.value).toBe(1);
    // Rescheduled from the current position (currentTime 0 → position 0);
    // this fake is suspended-state, so the epoch carries no lead.
    expect(fresh.startCalls[0]).toEqual({ when: 0, offset: 0, duration: 1 });
  });

  it('re-wires the natural-end carrier onto the (possibly new) last-ending source', () => {
    const { player, ctx } = makePlayer();
    const { t1, t2, d } = twoTrackFixture();
    player.play(0, session([t1, t2]), d);
    // t2's clip ends last (1500) — it carries onended.
    expect(ctx.sources[1].onended).not.toBeNull();
    expect(ctx.sources[0].onended).toBeNull();

    const t2b = { ...t2, automation: [volLane([{ positionSample: 0, value: -3 }])] };
    player.refreshTracks(session([t1, t2b]), d, [t2.id]);

    const fresh = ctx.sources[2];
    expect(fresh.onended).not.toBeNull(); // still the 1500-end clip, now rebuilt
    expect(ctx.sources[0].onended).toBeNull();
    expect(player.state).toBe('playing');
  });

  it('removing the lane mid-play rebuilds back to static nodes (bakedVolume false again)', () => {
    const { player, ctx } = makePlayer();
    const { t1, t2, d } = twoTrackFixture();
    const t1a = { ...t1, volumeDb: 4, automation: [volLane([{ positionSample: 0, value: -6 }])] };
    player.play(0, session([t1a, t2]), d);
    expect(player.liveTrackNodes(t1.id)?.bakedVolume).toBe(true);

    const t1b = { ...t1, volumeDb: 4 }; // lane gone
    player.refreshTracks(session([t1b, t2]), d, [t1.id]);

    const nodes = player.liveTrackNodes(t1.id);
    expect(nodes?.bakedVolume).toBe(false);
    expect(nodes?.volumeGain.gain.value).toBeCloseTo(dbToLinear(4), 12);
    const data = ctx.sources[2].buffer?.copied[0];
    if (!data) throw new Error('no buffer');
    expect(data[0]).toBe(0.5); // untouched slice again
  });
});

describe('RULING: player-rendered output === mixdownSession output over a MOVING automation region', () => {
  /** Both lanes automated on both tracks; every remaining live node gain is
   * exactly 1 (volume/pan neutralised, mute 1, master 1), and the two tracks'
   * clips do NOT overlap in time — so parity is EXACT float32 equality, the
   * strongest tier the v1.9 suite defines. Static fields are non-neutral so
   * a partial override (or an offset semantics) breaks the anchors. */
  function exactFixture(): { s: Session; d: Map<string, AudioDocument> } {
    const vKeys: AutomationKey[] = [
      { positionSample: 200, value: -6, curve: 'equal-gain' },
      { positionSample: 800, value: 3, curve: 'smooth' },
      { positionSample: 950, value: 0 },
    ];
    const pKeys: AutomationKey[] = [
      { positionSample: 300, value: -0.8, curve: 'smooth' },
      { positionSample: 700, value: 0.6 },
    ];
    const v2Keys: AutomationKey[] = [
      { positionSample: 1200, value: 2, curve: 'exponential' },
      { positionSample: 1900, value: -12 },
    ];
    const p2Keys: AutomationKey[] = [
      { positionSample: 1000, value: 1, curve: 'equal-gain' },
      { positionSample: 2000, value: -1 },
    ];
    const s = session([
      track({
        volumeDb: 2,
        pan: 0.4, // both overridden
        clips: [clip({ documentId: 'st', startSample: 0, lengthSample: 1000 })],
        automation: [volLane(vKeys), panLane(pKeys)],
      }),
      track({
        volumeDb: -1.5,
        pan: -0.6,
        clips: [clip({ documentId: 'm', startSample: 1000, lengthSample: 1000 })],
        automation: [volLane(v2Keys), panLane(p2Keys)],
      }),
    ]);
    return { s, d: docs(stereoDoc('st', 0.5, -0.25, 1000), monoDoc('m', 0.5, 1000)) };
  }

  it('EXACT (0) parity across both moving regions when every live gain is exactly 1', () => {
    const { s, d } = exactFixture();
    const { player, ctx } = makePlayer();
    player.play(0, s, d);
    const mix = mixdownSession(s, d).channels;
    const emu = renderPlayerGraph(ctx, 1000, mix[0].length);

    for (const ch of [0, 1] as const) {
      expect(maxAbsDiff(emu[ch], mix[ch], 0, 0, 1000)).toBe(0); // stereo clip, both lanes moving
      expect(maxAbsDiff(emu[ch], mix[ch], 0, 1000, 2000)).toBe(0); // mono clip, promoted pan bake
    }

    // Anti-vacuity anchors — law-derived absolute values, written from the
    // formulas (not the shared helpers), so identical-but-wrong paths fail:
    const mixL = mix[0];
    const mixR = mix[1];
    // s=100: hold region — vol −6 dB, pan −0.8 (NOT the static 2 dB / 0.4).
    {
      const { gL } = stereoGains(-0.8);
      expect(mixL[100]).toBeCloseTo(0.5 * dbToLinear(-6) * gL, 6);
    }
    // s=500: vol = −6 + 9·(300/600) = −1.5 dB (equal-gain); pan smooth at
    // u=0.5 → −0.8 + 1.4·0.5 = −0.1; stereo balance law.
    {
      const { gL, gR } = stereoGains(-0.1);
      expect(mixL[500]).toBeCloseTo(0.5 * dbToLinear(-1.5) * gL, 6);
      expect(mixR[500]).toBeCloseTo(-0.25 * dbToLinear(-1.5) * gR, 6);
    }
    // s=1500: mono clip — vol exponential u=(300/700): 2 + (−14)·u²;
    // pan = 1 − 2·(500/1000) = 0 → MONO law: both sides ·cos(π/4).
    {
      const u = 300 / 700;
      const vol = 2 + -14 * (u * u);
      expect(mixL[1500]).toBeCloseTo(0.5 * dbToLinear(vol) * Math.cos(Math.PI / 4), 6);
      expect(mixR[1500]).toBeCloseTo(0.5 * dbToLinear(vol) * Math.sin(Math.PI / 4), 6);
    }

    function stereoGains(pan: number): { gL: number; gR: number } {
      return {
        gL: pan <= 0 ? 1 : Math.cos((pan * Math.PI) / 2),
        gR: pan >= 0 ? 1 : Math.cos((-pan * Math.PI) / 2),
      };
    }
  });

  it('<1e-6 parity when a LIVE static node gain is non-unity (vol lane + static pan, mono clip)', () => {
    const vKeys: AutomationKey[] = [
      { positionSample: 100, value: -9, curve: 'smooth' },
      { positionSample: 900, value: 1.5 },
    ];
    const s = session([
      track({
        volumeDb: 5, // overridden by the lane
        pan: 0.37, // LIVE static pan → non-unity node gains → 1e-6 tier
        clips: [clip({ documentId: 'm', startSample: 0, lengthSample: 1000 })],
        automation: [volLane(vKeys)],
      }),
    ]);
    const d = docs(monoDoc('m', 0.5, 1000));
    const { player, ctx } = makePlayer();
    player.play(0, s, d);
    const mix = mixdownSession(s, d).channels;
    const emu = renderPlayerGraph(ctx, 1000, mix[0].length);

    expect(maxAbsDiff(emu[0], mix[0], 0, 0, 1000)).toBeLessThan(1e-6);
    expect(maxAbsDiff(emu[1], mix[1], 0, 0, 1000)).toBeLessThan(1e-6);
    // Anchor mid-ramp: smooth u=0.5 → vol = −9 + 10.5·0.5 = −3.75 dB, static
    // pan 0.37 under the mono law — and NOT the static 5 dB.
    const theta = ((0.37 + 1) / 2) * (Math.PI / 2);
    expect(mix[0][500]).toBeCloseTo(0.5 * dbToLinear(-3.75) * Math.cos(theta), 6);
    expect(mix[1][500]).toBeCloseTo(0.5 * dbToLinear(-3.75) * Math.sin(theta), 6);
  });

  it('survives seeking into the MIDDLE of a moving region (baked envelope, offset playback)', () => {
    const { s, d } = exactFixture();
    const from = 500; // mid-ramp of track 1's volume AND pan lanes
    const { player, ctx } = makePlayer();
    player.play(from, s, d);
    const mix = mixdownSession(s, d).channels;
    const emu = renderPlayerGraph(ctx, 1000, mix[0].length - from);

    for (const ch of [0, 1] as const) {
      expect(maxAbsDiff(emu[ch], mix[ch], from, from, 2000)).toBe(0);
    }
    // The first played sample is DEEP in the envelope — a player that
    // restarted the envelope at the seek point would play −6 dB / pan −0.8.
    const vol = -1.5; // −6 + 9·(300/600), see the exact fixture
    const gL = 1; // stereo balance law, pan −0.1 → left side unity
    expect(Math.fround(emu[0][0])).toBeCloseTo(0.5 * dbToLinear(vol) * gL, 6);
  });

  it('what the player passes the evaluator IS the timeline sample (wiring pin, F1 lesson)', () => {
    // Adjacent-sample key pair: any indexing slip in buildClipBuffer's
    // timeline conversion flips which value lands on buffer index 10.
    const kA: AutomationKey[] = [
      { positionSample: 500, value: -60 },
      { positionSample: 501, value: 2 },
    ];
    const { player, ctx } = makePlayer();
    const t = track({
      clips: [clip({ documentId: 'm', startSample: 490, lengthSample: 100 })],
      automation: [volLane(kA)],
    });
    player.play(0, session([t]), docs(monoDoc('m', 0.5)));
    const data = ctx.sources[0].buffer?.copied[0];
    if (!data) throw new Error('no buffer');
    expect(data[10]).toBe(Math.fround(0.5 * dbToLinear(automationValueAt(kA, 500, 'volumeDb'))));
    expect(data[10]).toBeCloseTo(0.5 * dbToLinear(-60), 6);
    expect(data[11]).toBeCloseTo(0.5 * dbToLinear(2), 6);
  });
});

// ---------------------------------------------------------------------------
// F5, player side: the spatial group baked through the SAME machinery as the
// pan lane — promoted 2-channel buffers, neutralised pan pair, bakedPan skip
// — and the RULING-2 parity proof: player output === mixdownSession output,
// EXACT float32 equality, across a region where azimuth crosses the ±180
// seam and elevation and distance are moving simultaneously.
// ---------------------------------------------------------------------------

function azLane(keys: AutomationKey[]): AutomationLane {
  return { param: 'azimuth', keys };
}
function elLane(keys: AutomationKey[]): AutomationLane {
  return { param: 'elevation', keys };
}
function distLane(keys: AutomationKey[]): AutomationLane {
  return { param: 'distance', keys };
}
const RAD = Math.PI / 180;

describe('F5 player spatial baking (promoted buffers, neutralised nodes, T2 skip)', () => {
  it('a DISTANCE-only lane promotes a mono clip to 2 channels, neutralises the pan pair', () => {
    const dKeys: AutomationKey[] = [
      { positionSample: 300, value: 0, curve: 'equal-gain' },
      { positionSample: 700, value: 2 },
    ];
    const { player, ctx } = makePlayer();
    const t = track({
      pan: 0.7, // superseded by the spatial group (ruling 4)
      volumeDb: -2, // NOT automated: stays on the live node
      clips: [clip({ documentId: 'm', startSample: 100, lengthSample: 800 })],
      automation: [distLane(dKeys)],
    });
    player.play(0, session([t]), docs(monoDoc('m', 0.5)));

    const buf = ctx.sources[0].buffer;
    if (!buf) throw new Error('no buffer');
    expect(buf.numberOfChannels).toBe(2); // promoted exactly like a pan lane (T3)
    // Neutral azimuth/elevation → centred MONO law × the inverse distance
    // gain, written from the laws: below the reference (unity), on it, above.
    const centre = Math.cos(Math.PI / 4);
    expect(buf.copied[0][300]).toBeCloseTo(0.5 * centre * 1, 6); // d(400)=0.5 → unity
    expect(buf.copied[0][400]).toBeCloseTo(0.5 * centre * 1, 6); // d(500)=1 → ON ref
    expect(buf.copied[0][500]).toBeCloseTo(0.5 * centre * (1 / 1.5), 6); // d(600)=1.5
    expect(buf.copied[1][500]).toBeCloseTo(0.5 * centre * (1 / 1.5), 6);
    // Exact product of the shared helper, both channels, across the ramp:
    for (const i of [0, 250, 450, 799]) {
      const p = autoSpatialGainsAt({ azimuth: null, elevation: null, distance: dKeys }, 100 + i, true);
      expect(buf.copied[0][i]).toBe(Math.fround(0.5 * 1 * 1 * p.gL * 1));
      expect(buf.copied[1][i]).toBe(Math.fround(0.5 * 1 * 1 * p.gR * 1));
    }
    // The pan pair is unity; volume stays live/static; bakedPan is set.
    const nodes = player.liveTrackNodes(t.id);
    expect(nodes?.bakedPan).toBe(true);
    expect(nodes?.bakedVolume).toBe(false);
    const pans = nodes?.clipPans.get(t.clips[0].id);
    expect(pans?.panL.gain.value).toBe(1);
    expect(pans?.panR.gain.value).toBe(1);
    expect(nodes?.volumeGain.gain.value).toBeCloseTo(dbToLinear(-2), 12);
  });

  it('with BOTH a pan lane and a spatial lane, the bake carries the SPATIAL image (ruling 4 order)', () => {
    // Pan lane hard-LEFT vs azimuth hard-RIGHT — the ordering discriminator
    // the mixdown suite pins, now pinned on the PLAYER bake too (review
    // round 1: swapping the player's branch survived without this).
    const az: AutomationKey[] = [{ positionSample: 0, value: 90 }];
    const pan: AutomationKey[] = [{ positionSample: 0, value: -1 }];
    const { player, ctx } = makePlayer();
    const t = track({
      pan: -0.8, // static also superseded
      clips: [clip({ documentId: 'm', startSample: 0, lengthSample: 500 })],
      automation: [panLane(pan), azLane(az)],
    });
    player.play(0, session([t]), docs(monoDoc('m', 0.5)));

    const buf = ctx.sources[0].buffer;
    if (!buf) throw new Error('no buffer');
    // Spatial governs: az 90 → pos sin(90°) = 1 → mono law hard right
    // (gL = cos(π/2) ≈ 0, gR = 1). The pan lane at −1 would put the whole
    // signal on the LEFT (gL = 1, gR = 0) — written from the law, inline.
    expect(buf.copied[0][250]).toBeCloseTo(0.5 * Math.cos(Math.PI / 2), 6);
    expect(buf.copied[1][250]).toBeCloseTo(0.5, 6);
    expect(player.liveTrackNodes(t.id)?.bakedPan).toBe(true);
  });

  it('applyTrackParams cannot stomp a spatially-baked pan pair (trap T2)', () => {
    const { player } = makePlayer();
    const t = track({
      pan: 0,
      clips: [clip({ documentId: 'm', startSample: 0, lengthSample: 1000 })],
      automation: [azLane([{ positionSample: 0, value: 45 }])],
    });
    player.play(0, session([t]), docs(monoDoc('m', 0.5)));
    const nodes = player.liveTrackNodes(t.id);
    const pans = nodes?.clipPans.get(t.clips[0].id);
    expect(pans?.panL.gain.value).toBe(1);

    player.applyTrackParams([{ ...t, pan: -0.9, volumeDb: -3 }]);

    expect(pans?.panL.gain.value).toBe(1); // baked: untouched
    expect(pans?.panR.gain.value).toBe(1);
    expect(nodes?.volumeGain.gain.value).toBeCloseTo(dbToLinear(-3), 12); // live vol applied
  });

  it('what the bake passes the evaluator IS the timeline sample (wiring pin, F1 lesson)', () => {
    // Adjacent azimuth keys flip the image hard-left → hard-right between
    // two consecutive TIMELINE samples; any indexing slip lands both on one.
    const kA: AutomationKey[] = [
      { positionSample: 500, value: -90 },
      { positionSample: 501, value: 90 },
    ];
    const { player, ctx } = makePlayer();
    const t = track({
      clips: [clip({ documentId: 'm', startSample: 490, lengthSample: 100 })],
      automation: [azLane(kA)],
    });
    player.play(0, session([t]), docs(monoDoc('m', 0.5)));
    const buf = ctx.sources[0].buffer;
    if (!buf) throw new Error('no buffer');
    // Buffer index 10 = timeline 500 (az −90): mono law at pos −1 → gL 1, gR 0.
    expect(buf.copied[0][10]).toBeCloseTo(0.5 * Math.cos(0), 6);
    expect(buf.copied[1][10]).toBeCloseTo(0.5 * Math.sin(0), 6);
    // Buffer index 11 = timeline 501 (az +90): pos 1 → gL 0, gR 1.
    expect(buf.copied[0][11]).toBeCloseTo(0.5 * Math.cos(Math.PI / 2), 6);
    expect(buf.copied[1][11]).toBeCloseTo(0.5, 6);
  });
});

describe('F5 RULING 2: player output === mixdown output over a MOVING spatial region', () => {
  /** Track 1 (stereo): azimuth crosses the ±180 seam while elevation and
   * distance are BOTH moving; track 2 (mono, promoted buffer): a rear pass
   * through −180 with a volume lane composing. Static pan is non-neutral on
   * both (superseded → unity nodes); static volume is 0 where not automated
   * (dbToLinear(0) = 1 exactly) and non-neutral where a lane overrides it —
   * so every remaining live gain is EXACTLY 1 and parity is the exact-0
   * tier, the strongest the v1.9 suite defines. */
  function spatialFixture(): { s: Session; d: Map<string, AudioDocument> } {
    const az1: AutomationKey[] = [
      { positionSample: 200, value: 170, curve: 'equal-gain' },
      { positionSample: 600, value: -170, curve: 'smooth' },
      { positionSample: 950, value: -20 },
    ];
    const el1: AutomationKey[] = [
      { positionSample: 300, value: -45, curve: 'equal-gain' },
      { positionSample: 800, value: 60 },
    ];
    const d1: AutomationKey[] = [
      { positionSample: 100, value: 0.5, curve: 'equal-gain' },
      { positionSample: 900, value: 4 },
    ];
    const az2: AutomationKey[] = [
      { positionSample: 1100, value: -120, curve: 'equal-gain' },
      { positionSample: 1800, value: 120 },
    ];
    const v2: AutomationKey[] = [
      { positionSample: 1200, value: 3, curve: 'smooth' },
      { positionSample: 1700, value: -9 },
    ];
    // Both tracks ALSO carry a hard-panned PAN LANE that ruling 4 supersedes
    // (hard-left on the stereo track, hard-right on the mono track — images
    // maximally far from the spatial anchors). This folds the player-side
    // supersede ORDER into the exactness assertion itself: a player branch
    // that lets the pan lane win bakes the pan image while mixdown renders
    // the spatial one, and every exact-0 comparison (and every anchor) goes
    // red — review round 1's survivor, now pinned.
    const s = session([
      track({
        volumeDb: 0, // NOT automated: live node dbToLinear(0) = 1 exactly
        pan: 0.4, // superseded by the spatial group → neutralised node
        clips: [clip({ documentId: 'st', startSample: 0, lengthSample: 1000 })],
        automation: [azLane(az1), elLane(el1), distLane(d1), panLane([{ positionSample: 0, value: -1 }])],
      }),
      track({
        volumeDb: 3, // overridden by the volume lane → neutralised node
        pan: -0.6, // superseded
        clips: [clip({ documentId: 'm', startSample: 1000, lengthSample: 1000 })],
        automation: [azLane(az2), volLane(v2), panLane([{ positionSample: 1000, value: 1 }])],
      }),
    ]);
    return { s, d: docs(stereoDoc('st', 0.5, -0.25, 1000), monoDoc('m', 0.5, 1000)) };
  }

  it('EXACT (0) parity across both moving spatial regions', () => {
    const { s, d } = spatialFixture();
    const { player, ctx } = makePlayer();
    player.play(0, s, d);
    const mix = mixdownSession(s, d).channels;
    const emu = renderPlayerGraph(ctx, 1000, mix[0].length);

    for (const ch of [0, 1] as const) {
      expect(maxAbsDiff(emu[ch], mix[ch], 0, 0, 1000)).toBe(0); // stereo, wrap + el + dist
      expect(maxAbsDiff(emu[ch], mix[ch], 0, 1000, 2000)).toBe(0); // mono, promoted bake
    }

    // Anti-vacuity anchors — the whole chain written from the formulas
    // (sin/cos/inverse-distance/balance/mono laws inline), NOT the helpers:
    const mixL = mix[0];
    const mixR = mix[1];
    // s=400 — azimuth mid-seam: az = 170 + 20·0.5 = 180 → pos = sin(180°)·
    // cos(el(400)) with el = −45 + 105·(100/500) = −24; dist = 0.5 +
    // 3.5·(300/800) = 1.8125 → gain 1/1.8125. Balance law at pos ≈ 0: both
    // sides ≈ unity × the distance gain.
    {
      const pos = Math.sin(180 * RAD) * Math.cos(-24 * RAD);
      const gL = pos <= 0 ? 1 : Math.cos((pos * Math.PI) / 2);
      const gR = pos >= 0 ? 1 : Math.cos((-pos * Math.PI) / 2);
      const dg = 1 / 1.8125;
      expect(mixL[400]).toBeCloseTo(0.5 * gL * dg, 6);
      expect(mixR[400]).toBeCloseTo(-0.25 * gR * dg, 6);
    }
    // s=150 — hold + below-reference distance: az held 170, el held −45,
    // dist = 0.5 + 3.5·(50/800) = 0.71875 < 1 → unity gain (the below/on
    // boundary probe). pos = sin(170°)·cos(−45°) > 0 → balance attenuates L.
    {
      const pos = Math.sin(170 * RAD) * Math.cos(-45 * RAD);
      expect(mixL[150]).toBeCloseTo(0.5 * Math.cos((pos * Math.PI) / 2) * 1, 6);
      expect(mixR[150]).toBeCloseTo(-0.25 * 1 * 1, 6);
    }
    // s=1450 — track 2's rear pass hits the seam: az = −120 − 120·(350/700)
    // = −180 → pos ≈ 0 → centred MONO law; vol = 3 − 12·smooth(0.5) = −3 dB
    // (the smooth curve is the raised cosine (1 − cos πt)/2, = 0.5 at 0.5).
    {
      const vol = 3 - 12 * ((1 - Math.cos(Math.PI * 0.5)) / 2);
      expect(mixL[1450]).toBeCloseTo(0.5 * dbToLinear(vol) * Math.cos(Math.PI / 4), 6);
      expect(mixR[1450]).toBeCloseTo(0.5 * dbToLinear(vol) * Math.sin(Math.PI / 4), 6);
    }
    // s=1275 — mid-arc, off the seam: az = −120 − 120·(175/700) = −150 →
    // pos = sin(−150°) = −0.5 → mono law θ = π/8; vol = 3 − 12·smooth(0.15),
    // raised cosine written inline.
    {
      const u = 0.15;
      const vol = 3 - 12 * ((1 - Math.cos(Math.PI * u)) / 2);
      const theta = ((-0.5 + 1) / 2) * (Math.PI / 2);
      expect(mixL[1275]).toBeCloseTo(0.5 * dbToLinear(vol) * Math.cos(theta), 6);
      expect(mixR[1275]).toBeCloseTo(0.5 * dbToLinear(vol) * Math.sin(theta), 6);
    }
    // The superseded statics would land elsewhere: pan 0.4 on track 1 would
    // attenuate L to cos(0.2π) ≈ 0.809 in the hold region — pinned absent.
    expect(mixR[150]).not.toBeCloseTo(-0.25 * Math.cos((0.4 * Math.PI) / 2), 2);
  });

  it('EXACT parity survives seeking into the MIDDLE of the wrap segment', () => {
    const { s, d } = spatialFixture();
    const from = 450; // inside track 1's azimuth seam crossing
    const { player, ctx } = makePlayer();
    player.play(from, s, d);
    const mix = mixdownSession(s, d).channels;
    const emu = renderPlayerGraph(ctx, 1000, mix[0].length - from);

    for (const ch of [0, 1] as const) {
      expect(maxAbsDiff(emu[ch], mix[ch], from, from, 2000)).toBe(0);
    }
    // First played sample is DEEP in the moving region: az(450) = 170 +
    // 20·(250/400) = 182.5 → wrapped −177.5; el(450) = −45 + 105·(150/500)
    // = −13.5; dist(450) = 0.5 + 3.5·(350/800) = 2.03125.
    const pos = Math.sin(-177.5 * RAD) * Math.cos(-13.5 * RAD);
    const gR = pos >= 0 ? 1 : Math.cos((-pos * Math.PI) / 2);
    expect(Math.fround(emu[1][0])).toBeCloseTo((-0.25 * gR) / 2.03125, 6);
  });
});
