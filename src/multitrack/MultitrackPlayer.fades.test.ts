import { createDocument, type AudioDocument } from '../audio/AudioDocument';
import { crossfadeGains } from '../dsp/fades';
import { mixdownSession, monoPanGains } from './mixdown';
import { MultitrackPlayer } from './MultitrackPlayer';
import type { Clip, Session, Track } from './session';

// ---------------------------------------------------------------------------
// X3, player side: fades/crossfades baked into the clip AudioBuffers, and the
// RULING-4 PARITY PROOF -- the player's rendered output compared to
// `mixdownSession` output SAMPLE BY SAMPLE over a crossfade region.
//
// The existing pan-law tests compare node parameter values only (T25); a
// wrong envelope in `buildClipBuffer` passes all of them. These tests read
// the actual baked buffer contents, then render the player's scheduled graph
// numerically: each source's buffer samples are placed by its captured
// `start(when, offset, duration)` call and multiplied through its captured
// gain chain (pan -> merger -> volume -> mute -> master), accumulating in
// double precision. That is exactly the linear arithmetic the real Web Audio
// graph performs on these nodes; no fake node "renders" anything, the test
// does.
//
// TOLERANCES (T26 -- measure before calling a difference a fade bug): the two
// paths round to float32 at different points (mixdown stores the running sum
// per accumulate; the player stores the baked buffer, then the graph sums).
// Where only ONE clip sounds and every graph gain is exactly 1, both paths
// compute float32(sample * env) from identical doubles -- compared EXACTLY.
// Where two clips overlap, the sums differ by at most an ulp or two of
// float32 (~1e-7); compared against 1e-6, well below the smallest realistic
// envelope error (an off-by-one ramp denominator shifts mid-ramp samples in
// these fixtures by ~2e-3; the absolute anchors, asserting at 5e-7, catch
// even that). Fixtures keep
// |sum| < 1 and tracks unmuted so the clamp/mute/length divergences (which
// predate fades) never enter the comparison (per coupling C6).
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
    // parity fixtures never tear down mid-assert
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
  start(when = 0, offset?: number, duration?: number): void {
    this.startCalls.push({ when, offset, duration });
  }
  stop(): void {
    // not exercised here
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

// --- graph renderer --------------------------------------------------------

interface Route {
  pan: FakeGain;
  bufCh: number;
  /** Master side this route feeds: merger input 0 = L, 1 = R. */
  side: 0 | 1;
}

function sideOf(pan: FakeGain): 0 | 1 {
  return (pan.connections[0].input ?? 0) === 1 ? 1 : 0;
}

function routesOf(src: FakeSource): Route[] {
  const first = src.connections[0]?.dest;
  if (first instanceof FakeSplitter) {
    // Stereo: splitter output N carries buffer channel N into its pan gain.
    return first.connections.map((cn) => ({
      pan: cn.dest as FakeGain,
      bufCh: cn.output ?? 0,
      side: sideOf(cn.dest as FakeGain),
    }));
  }
  // Mono: the single buffer channel fans into both pan gains directly.
  return src.connections.map((cn) => ({
    pan: cn.dest as FakeGain,
    bufCh: 0,
    side: sideOf(cn.dest as FakeGain),
  }));
}

/** The route's total gain: pan -> (merger) -> volume -> mute -> master. */
function chainGain(pan: FakeGain): number {
  const merger = pan.connections[0].dest as FakeMerger;
  const volume = merger.connections[0].dest as FakeGain;
  const mute = volume.connections[0].dest as FakeGain;
  const master = mute.connections[0].dest as FakeGain;
  return pan.gain.value * volume.gain.value * mute.gain.value * master.gain.value;
}

/**
 * Renders the player's scheduled graph into play-relative sample arrays
 * (index 0 == the `fromSample` the play started at). Placement comes from the
 * captured `start(when, offset, duration)` exactly as Web Audio would apply
 * it at the session rate.
 */
function renderPlayerGraph(ctx: FakeAudioContext, sr: number, outLen: number): [Float64Array, Float64Array] {
  const out: [Float64Array, Float64Array] = [new Float64Array(outLen), new Float64Array(outLen)];
  for (const src of ctx.sources) {
    if (!src.buffer || src.startCalls.length === 0) continue;
    const call = src.startCalls[0];
    // ABSOLUTE placement: play-relative sample 0 must sound at render time 0
    // — `when` is measured on the same clock a render starts from, which is
    // the axis the packaged smoke's real OfflineAudioContext render compares
    // against mixdownSession. A scheduling displacement (e.g. a lead applied
    // on this suite's frozen clock) must land HERE as a shifted render; the
    // renderer must never subtract it away (fix round 1's lesson: doing so
    // hid a 10 ms whole-render shift from every parity assertion).
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

/** Max |player - mixdown| over timeline samples [lo, hi), with the player
 * rendered from `from`. `exact` additionally requires float32 equality. */
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

// --- fixtures --------------------------------------------------------------

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

function monoDoc(id: string, value: number, length = 1000, sampleRate = 1000): AudioDocument {
  const d = createDocument({
    name: id,
    sampleRate,
    channels: [new Float32Array(length).fill(value)],
  });
  return { ...d, id };
}

function stereoDoc(id: string, l: number, r: number, length = 1000, sampleRate = 1000): AudioDocument {
  const d = createDocument({
    name: id,
    sampleRate,
    channels: [new Float32Array(length).fill(l), new Float32Array(length).fill(r)],
  });
  return { ...d, id };
}

function docs(...ds: AudioDocument[]): Map<string, AudioDocument> {
  return new Map(ds.map((d) => [d.id, d]));
}

/** The canonical crossfade session used by the parity tests: one track,
 * stereo sources, pan 0 (balance law => both pan gains EXACTLY 1), all
 * gains 0 dB. A [0,1000) solo fade-in 150 + facing fade-out 400 (equal-gain);
 * B [600,1600) facing fade-in 400 (equal-gain) + solo fade-out 200. The
 * equal-gain facing curves make the law's k-normalisation actually engage
 * (equal-power at rho 0 has k = 1 and would render identically to raw solo
 * fades -- parity would hold even if the crossfade branch were dead). */
function paritySession(): { s: Session; d: Map<string, AudioDocument> } {
  const a = stereoDoc('a', 0.5, -0.25);
  const b = stereoDoc('b', 0.3, -0.15);
  const s = session([
    track({
      clips: [
        clip({
          documentId: 'a',
          startSample: 0,
          lengthSample: 1000,
          fadeInSample: 150,
          fadeOutSample: 400,
          fadeOutCurve: 'equal-gain',
        }),
        clip({
          documentId: 'b',
          startSample: 600,
          lengthSample: 1000,
          fadeInSample: 400,
          fadeInCurve: 'equal-gain',
          fadeOutSample: 200,
        }),
      ],
    }),
  ]);
  return { s, d: docs(a, b) };
}

describe('MultitrackPlayer fade baking (buffer contents)', () => {
  it('bakes a solo fade-in into the buffer samples, exact float32 values', () => {
    const { player, ctx } = makePlayer();
    const s = session([
      track({ clips: [clip({ documentId: 'd', lengthSample: 500, fadeInSample: 8 })] }),
    ]);
    player.play(0, s, docs(monoDoc('d', 0.5, 500)));

    const data = ctx.sources[0].buffer?.copied[0];
    if (!data) throw new Error('no baked buffer');
    expect(data[0]).toBe(0);
    for (let i = 1; i < 8; i++) {
      expect(data[i]).toBe(Math.fround(0.5 * Math.sin((i / 7) * (Math.PI / 2))));
    }
    for (let i = 8; i < 500; i++) expect(data[i]).toBe(0.5);
  });

  it('leaves a fade-less unity-gain clip\'s buffer untouched (ruling 10, player side)', () => {
    const { player, ctx } = makePlayer();
    // Overlapping clips with NO fades: raw buffers, no implicit envelope.
    const s = session([
      track({
        clips: [
          clip({ documentId: 'd', startSample: 0, lengthSample: 500 }),
          clip({ documentId: 'd', startSample: 300, lengthSample: 500 }),
        ],
      }),
    ]);
    player.play(0, s, docs(monoDoc('d', 0.5, 500)));

    expect(ctx.sources).toHaveLength(2);
    for (const src of ctx.sources) {
      const data = src.buffer?.copied[0];
      if (!data) throw new Error('no buffer');
      for (let i = 0; i < 500; i++) expect(data[i]).toBe(0.5);
    }
  });

  it('composes the envelope with the baked clip gain in mixdown\'s multiply order', () => {
    const { player, ctx } = makePlayer();
    const s = session([
      track({
        clips: [
          clip({
            documentId: 'd',
            lengthSample: 500,
            gainDb: -6,
            fadeInSample: 8,
            fadeInCurve: 'equal-gain',
          }),
        ],
      }),
    ]);
    player.play(0, s, docs(monoDoc('d', 0.5, 500)));

    const g = Math.pow(10, -6 / 20);
    const data = ctx.sources[0].buffer?.copied[0];
    if (!data) throw new Error('no baked buffer');
    for (let i = 0; i < 8; i++) {
      expect(data[i]).toBe(Math.fround(0.5 * g * (i / 7)));
    }
    expect(data[100]).toBe(Math.fround(0.5 * g));
  });

  it('bakes the crossfade into BOTH members of a canonical pair (gOut / gIn of the same law)', () => {
    const { player, ctx } = makePlayer();
    const a = monoDoc('a', 0.6, 1000);
    const b = monoDoc('b', 0.4, 1000);
    const s = session([
      track({
        clips: [
          clip({
            documentId: 'a',
            startSample: 0,
            lengthSample: 1000,
            fadeOutSample: 400,
            fadeOutCurve: 'equal-gain',
          }),
          clip({
            documentId: 'b',
            startSample: 600,
            lengthSample: 1000,
            fadeInSample: 400,
            fadeInCurve: 'equal-gain',
          }),
        ],
      }),
    ]);
    player.play(0, s, docs(a, b));

    const bufA = ctx.sources[0].buffer?.copied[0];
    const bufB = ctx.sources[1].buffer?.copied[0];
    if (!bufA || !bufB) throw new Error('missing baked buffers');
    // The source docs hold float32(0.6) / float32(0.4) -- neither is exactly
    // representable -- so the expected products start from the stored values.
    const a6 = Math.fround(0.6);
    const b4 = Math.fround(0.4);
    for (const j of [0, 100, 200, 399]) {
      const { gOut, gIn } = crossfadeGains(j / 399, 0, 'equal-gain');
      expect(bufA[600 + j]).toBe(Math.fround(a6 * gOut)); // A's last 400 samples
      expect(bufB[j]).toBe(Math.fround(b4 * gIn)); // B's first 400 samples
    }
    expect(bufA[599]).toBe(Math.fround(0.6)); // superseded solo fade: untouched before the overlap
    expect(bufB[400]).toBe(Math.fround(0.4)); // and after it
  });

  it('bakes a ONE-sample crossfade at the law midpoint t = 0.5 into both members (no 0/0 ramp)', () => {
    // The player-side twin of the mixdown fixture: w = 1 has no i/(w-1) to
    // evaluate (0/0 = NaN straight into the AudioBuffer); the bake must take
    // the midpoint t = 0.5 for the single shared sample.
    const { player, ctx } = makePlayer();
    const s = session([
      track({
        clips: [
          clip({ documentId: 'a', startSample: 0, lengthSample: 500, fadeOutSample: 1 }),
          clip({ documentId: 'b', startSample: 499, lengthSample: 500, fadeInSample: 1 }),
        ],
      }),
    ]);
    player.play(0, s, docs(monoDoc('a', 0.6, 500), monoDoc('b', 0.4, 500)));

    const bufA = ctx.sources[0].buffer?.copied[0];
    const bufB = ctx.sources[1].buffer?.copied[0];
    if (!bufA || !bufB) throw new Error('missing baked buffers');
    const { gOut, gIn } = crossfadeGains(0.5, 0);
    expect(Number.isNaN(bufA[499])).toBe(false);
    expect(Number.isNaN(bufB[0])).toBe(false);
    expect(bufA[499]).toBe(Math.fround(Math.fround(0.6) * gOut));
    expect(bufB[0]).toBe(Math.fround(Math.fround(0.4) * gIn));
    expect(bufA[498]).toBe(Math.fround(0.6)); // untouched up to the single shared sample
    expect(bufB[1]).toBe(Math.fround(0.4)); // and after it
  });

  it('bakes region-exact values at BOTH memcpy seams (boundary fixture, one sample either side)', () => {
    // The bake runs the per-sample envelope only over the fade regions and
    // copies the unity middle. The seams are the probe positions: the head
    // region is [0, 8) (fade-in 8) and the tail region [492, 500) (fade-out
    // 8 on a 500-length clip), each asserted at the region edge and one
    // sample either side. The ramps are endpoint-inclusive (env(7) = 1 on
    // the way in, env(492) = 1 on the way out), so a boundary off by ONE is
    // value-neutral by the law itself; the probes one sample INSIDE each
    // region (6 and 493) catch any larger slip, and 8/491 pin that the
    // copied middle still carries the clip gain. Clip gain is non-unity so
    // the gain-only middle path (not the raw memcpy) is the one under test.
    const { player, ctx } = makePlayer();
    const s = session([
      track({
        clips: [
          clip({ documentId: 'd', lengthSample: 500, gainDb: -6, fadeInSample: 8, fadeOutSample: 8 }),
        ],
      }),
    ]);
    player.play(0, s, docs(monoDoc('d', 0.5, 500)));

    const data = ctx.sources[0].buffer?.copied[0];
    if (!data) throw new Error('no baked buffer');
    const g = Math.pow(10, -6 / 20);
    // Head seam (region edge 7|8): last two faded samples, first copied one.
    expect(data[6]).toBe(Math.fround(0.5 * g * Math.sin((6 / 7) * (Math.PI / 2)))); // mid-ramp, ≠ plateau
    expect(data[7]).toBe(Math.fround(0.5 * g * Math.sin((7 / 7) * (Math.PI / 2)))); // ramp endpoint (= plateau by law)
    expect(data[8]).toBe(Math.fround(0.5 * g)); // first middle sample
    // Tail seam (region edge 491|492): last copied sample, first two faded.
    expect(data[491]).toBe(Math.fround(0.5 * g)); // last middle sample
    expect(data[492]).toBe(Math.fround(0.5 * g * Math.cos((0 / 7) * (Math.PI / 2)))); // region start (= plateau by law)
    expect(data[493]).toBe(Math.fround(0.5 * g * Math.cos((1 / 7) * (Math.PI / 2)))); // first strictly-attenuated
    // A plateau probe deep in the middle: the copy still carries the gain.
    expect(data[250]).toBe(Math.fround(0.5 * g));
  });

  it('applies one envelope identically to both channels of a stereo clip', () => {
    const { player, ctx } = makePlayer();
    const s = session([
      track({
        clips: [
          clip({
            documentId: 'd',
            lengthSample: 500,
            fadeInSample: 10,
            fadeInCurve: 'equal-gain',
          }),
        ],
      }),
    ]);
    player.play(0, s, docs(stereoDoc('d', 0.5, -0.25, 500)));

    const buf = ctx.sources[0].buffer;
    if (!buf) throw new Error('no buffer');
    expect(buf.copied).toHaveLength(2);
    for (let i = 0; i < 10; i++) {
      expect(buf.copied[0][i]).toBe(Math.fround(0.5 * (i / 9)));
      expect(buf.copied[1][i]).toBe(Math.fround(-0.25 * (i / 9)));
    }
  });
});

describe('RULING 4: player-rendered output === mixdownSession output', () => {
  it('matches over a crossfade region: exact outside the overlap, <1e-6 inside (fp-rounding only)', () => {
    const { s, d } = paritySession();
    const { player, ctx } = makePlayer();
    player.play(0, s, d);
    const mix = mixdownSession(s, d).channels;
    const emu = renderPlayerGraph(ctx, 1000, mix[0].length);

    for (const ch of [0, 1] as const) {
      // Single-clip regions (solo fade-in, plateau, solo fade-out): the two
      // paths compute float32(sample * env) from IDENTICAL doubles -- exact.
      expect(maxAbsDiff(emu[ch], mix[ch], 0, 0, 600)).toBe(0);
      expect(maxAbsDiff(emu[ch], mix[ch], 0, 1000, 1600)).toBe(0);
      // The crossfade region sums two float32 contributions in different
      // orders; only store-rounding separates the paths.
      expect(maxAbsDiff(emu[ch], mix[ch], 0, 600, 1000)).toBeLessThan(1e-6);
    }

    // Anti-vacuity anchors: parity alone would also hold if BOTH paths
    // ignored fades identically, so pin the mixdown to absolute law-derived
    // values at spot samples (left channel; sources 0.5 / 0.3).
    const mixL = mix[0];
    expect(mixL[75]).toBeCloseTo(0.5 * Math.sin((75 / 149) * (Math.PI / 2)), 6); // solo fade-in
    for (const j of [100, 200, 300]) {
      const { gOut, gIn } = crossfadeGains(j / 399, 0, 'equal-gain');
      expect(mixL[600 + j]).toBeCloseTo(0.5 * gOut + 0.3 * gIn, 6); // the law, engaged
    }
    // B's solo fade-out carries no explicit curve, so it takes the DEFAULT
    // equal-power shape: cos over the 200-sample window ending at 1600.
    expect(mixL[1500]).toBeCloseTo(0.3 * Math.cos((100 / 199) * (Math.PI / 2)), 6);
  });

  it('holds through clip gain, track volume and pan (general fixture, <1e-6 everywhere)', () => {
    const a = monoDoc('a', 0.6, 1000);
    const b = monoDoc('b', 0.4, 1000);
    const s = session([
      track({
        pan: 0.37,
        volumeDb: 2,
        clips: [
          clip({
            documentId: 'a',
            startSample: 0,
            lengthSample: 1000,
            gainDb: -3.5,
            fadeOutSample: 400,
            fadeOutCurve: 'smooth',
          }),
          clip({
            documentId: 'b',
            startSample: 600,
            lengthSample: 1000,
            gainDb: -3.5,
            fadeInSample: 400,
            fadeInCurve: 'exponential',
          }),
        ],
      }),
      track({
        pan: -0.6,
        volumeDb: -1.5,
        clips: [clip({ documentId: 'a', startSample: 200, lengthSample: 800, fadeInSample: 120 })],
      }),
    ]);
    const d = docs(a, b);
    const { player, ctx } = makePlayer();
    player.play(0, s, d);
    const mix = mixdownSession(s, d).channels;
    const emu = renderPlayerGraph(ctx, 1000, mix[0].length);

    expect(maxAbsDiff(emu[0], mix[0], 0, 0, mix[0].length)).toBeLessThan(1e-6);
    expect(maxAbsDiff(emu[1], mix[1], 0, 0, mix[1].length)).toBeLessThan(1e-6);

    // Absolute anchor inside the MIXED-curve crossfade (smooth-out vs
    // exponential-in), through all the gains -- so the parity above cannot be
    // two identically-wrong paths.
    const g = Math.pow(10, -3.5 / 20) * Math.pow(10, 2 / 20);
    const { gL } = monoPanGains(0.37);
    const { gOut, gIn } = crossfadeGains(200 / 399, 0, 'smooth', 'exponential');
    const t2g = Math.pow(10, -1.5 / 20) * monoPanGains(-0.6).gL;
    const expected = (0.6 * gOut + 0.4 * gIn) * g * gL + 0.6 * t2g; // track 2's clip covers s=800
    expect(mix[0][800]).toBeCloseTo(expected, 6);
  });

  it('survives seeking into the middle of the crossfade (baked envelope, offset playback)', () => {
    const { s, d } = paritySession();
    const from = 800; // mid-crossfade
    const { player, ctx } = makePlayer();
    player.play(from, s, d);
    const mix = mixdownSession(s, d).channels;
    const emu = renderPlayerGraph(ctx, 1000, mix[0].length - from);

    for (const ch of [0, 1] as const) {
      expect(maxAbsDiff(emu[ch], mix[ch], from, from, 1000)).toBeLessThan(1e-6); // rest of the crossfade
      expect(maxAbsDiff(emu[ch], mix[ch], from, 1000, 1600)).toBe(0); // exact once solo again
    }
    // Anchor: the first played sample is deep in the crossfade, not at its
    // start -- a player that restarted the envelope at the seek point would
    // produce gOut(0)=1/gIn(0)=0 here instead.
    const { gOut, gIn } = crossfadeGains(200 / 399, 0, 'equal-gain');
    expect(Math.fround(emu[0][0])).toBeCloseTo(0.5 * gOut + 0.3 * gIn, 6);
  });
});
