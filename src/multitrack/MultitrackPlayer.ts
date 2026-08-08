import type { AudioDocument } from '../audio/AudioDocument';
import {
  clipFadeGainAt,
  monoPanGains,
  readClipSlice,
  resolveClipFadeSpecs,
  stereoBalanceGains,
  type ClipFadeSpec,
} from './mixdown';
import type { Clip, Session, Track } from './session';

export type MultitrackPlayState = 'stopped' | 'playing';

export interface MultitrackPlayerDeps {
  /** Injectable AudioContext factory; tests supply a fake, default builds a real one. */
  createContext?: () => AudioContext;
}

/**
 * Per-clip pan gain pair. `mode` records which pan law this clip's `panL`/`panR`
 * follow — chosen by the CLIP's source channel count, exactly like the offline
 * mixdown applies its law per clip (see `play`).
 */
export interface ClipPanNodes {
  panL: GainNode;
  panR: GainNode;
  mode: 'mono' | 'stereo';
}

/**
 * Live per-track nodes kept in the player's registry while playing, so track
 * parameter changes retro-apply to the running graph without a rebuild. Pan is
 * per CLIP (`clipPans`, keyed by clip id): the pan law depends on each clip's
 * source channel count, so a track mixing mono and stereo clips gets a distinct
 * gain pair per clip. Volume and mute are per track.
 */
export interface LiveTrackNodes {
  volumeGain: GainNode;
  muteGain: GainNode;
  clipPans: Map<string, ClipPanNodes>;
}

function dbToLinear(db: number): number {
  return Math.pow(10, db / 20);
}

/** Effective silence: a muted track is always silent; when any track is soloed,
 * only soloed tracks are audible (mute still wins on a soloed track). */
function isEffectivelyMuted(track: Track, anySolo: boolean): boolean {
  return track.muted || (anySolo && !track.solo);
}

/** Time constant (seconds) for live parameter ramps — a short `setTargetAtTime`
 * smoothing so fader/pan/mute moves don't click. */
const PARAM_SMOOTH = 0.015;

/**
 * Realtime WebAudio playback of a multitrack session. On each `play(fromSample)`
 * the whole graph is rebuilt. Per track the chain is
 *   per-clip panL/panR (`GainNode` pairs) → shared `ChannelMergerNode(2)`
 *     → volume (`GainNode`) → mute (`GainNode`) → shared master (`GainNode`)
 *     → destination,
 * with one `AudioBufferSourceNode` per clip whose end is past `fromSample`.
 * Buffers are built at the SESSION sample rate from the same slice/resample logic
 * as the offline mixdown (`readClipSlice`), with the clip's gain baked in.
 *
 * PAN LAW — implemented manually so realtime monitoring matches the offline
 * mixdown EXACTLY. Like the mixdown, the law is chosen PER CLIP by the clip's
 * source channel count (a track mixing mono and stereo clips therefore gets a
 * distinct pan pair per clip — the two laws differ by up to ~3 dB at center):
 *  - MONO clip: the mono buffer fans out into its own `panL`/`panR`, gains from
 *    `monoPanGains(track.pan)` (constant-power). merger input 0 = L, 1 = R.
 *  - STEREO clip: a `ChannelSplitterNode(2)` sends channel 0 → `panL`,
 *    channel 1 → `panR`, gains from `stereoBalanceGains(track.pan)` (balance).
 *
 * LIVE PARAMETERS: every track (audible or not) gets its full chain built and is
 * registered in `trackNodes`, so `applyTrackParams` can retro-apply volume, pan,
 * and mute/solo changes to the RUNNING graph via `setTargetAtTime` — no rebuild,
 * no source restart. Pan updates every clip's gain pair under that clip's OWN
 * law. Effective mute (mute + solo) rides the per-track `muteGain` (0/1), so
 * muting/soloing/un-muting is audible immediately.
 *
 * Sources are scheduled at `ctx.currentTime + max(0, (clipStart − from)/rate)`
 * with a mid-clip start offset and the remaining duration, so seeking into the
 * middle of the timeline plays every clip from exactly the right point. Position
 * is derived from `ctx.currentTime` (never a timer) and clamped to the last
 * clip end.
 *
 * DELIBERATE LIMITATION (Audition-comparable, NOT a KNOWN_LIMITATIONS entry):
 * clip GEOMETRY and clip GAIN are baked per source buffer, so clip moves/trims
 * and clip-gain changes only take effect on the next `play()`. Buffers are also
 * rebuilt every `play()` (no cache); sessions are small.
 */
export class MultitrackPlayer {
  private readonly deps: MultitrackPlayerDeps;

  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  /** Track-level nodes (gains, splitters, mergers) to disconnect on teardown. */
  private graphNodes: AudioNode[] = [];
  private sources: AudioBufferSourceNode[] = [];
  /** Live per-track node registry, keyed by track id (empty while stopped). */
  private trackNodes = new Map<string, LiveTrackNodes>();

  private _state: MultitrackPlayState = 'stopped';
  /** Sample the current play started from (stop/end return here). */
  private playStartSample = 0;
  /** `ctx.currentTime` captured at play, for position derivation. */
  private startedAt = 0;
  /** Stored position used while stopped. */
  private position = 0;
  /** Session sample rate of the active playback. */
  private rate = 44100;
  /** Upper sample bound (last scheduled clip end). */
  private endSample = 0;

  private readonly stateCbs = new Set<(state: MultitrackPlayState) => void>();

  constructor(deps?: MultitrackPlayerDeps) {
    this.deps = deps ?? {};
  }

  get state(): MultitrackPlayState {
    return this._state;
  }

  play(fromSample: number, session: Session, docs: Map<string, AudioDocument>): void {
    const ctx = this.ensureContext();
    if (!ctx) return;

    // Tear down any prior graph WITHOUT emitting (play is not a stop).
    this.teardown();

    const sr = session.sampleRate;
    const from = Math.max(0, Math.floor(fromSample));
    const anySolo = session.tracks.some((t) => t.solo);

    const master = ctx.createGain();
    master.gain.value = 1;
    master.connect(ctx.destination);

    const graphNodes: AudioNode[] = [master];
    const sources: AudioBufferSourceNode[] = [];
    let endSample = from;
    let latest: AudioBufferSourceNode | null = null;
    let latestEnd = -Infinity;

    // Build EVERY track's full chain (even muted/solo-excluded ones) so live
    // mute/solo/volume/pan changes can retro-apply to the running graph. A
    // track with no clip past `from` contributes nothing and is skipped.
    for (const t of session.tracks) {
      // Fades/crossfades resolved from the SAME shared resolver as the offline
      // mixdown, per track, and baked into the buffers below -- so live
      // playback and `mixdownSession` apply identical envelope gains (ruling
      // 4). Resolution is play-position-agnostic: the whole envelope is baked
      // and a seek is just a buffer offset, so it survives seeking like the
      // baked clip gain does.
      const fadeSpecs = resolveClipFadeSpecs(t.clips);
      const built: { clip: Clip; buffer: AudioBuffer }[] = [];
      for (const c of t.clips) {
        if (c.startSample + c.lengthSample <= from) continue;
        const doc = docs.get(c.documentId);
        if (!doc) continue;
        const buffer = this.buildClipBuffer(ctx, c, doc, sr, fadeSpecs.get(c.id));
        if (!buffer) continue;
        built.push({ clip: c, buffer });
      }
      if (built.length === 0) continue;

      // Per-track chain: per-clip panL/panR -> shared merger(2) -> volume ->
      // mute -> master. The pan LAW is chosen per clip below, like the mixdown.
      const merger = ctx.createChannelMerger(2);
      const volumeGain = ctx.createGain();
      volumeGain.gain.value = dbToLinear(t.volumeDb);
      const muteGain = ctx.createGain();
      muteGain.gain.value = isEffectivelyMuted(t, anySolo) ? 0 : 1;

      merger.connect(volumeGain);
      volumeGain.connect(muteGain);
      muteGain.connect(master);
      graphNodes.push(merger, volumeGain, muteGain);
      const clipPans = new Map<string, ClipPanNodes>();
      this.trackNodes.set(t.id, { volumeGain, muteGain, clipPans });

      for (const { clip: c, buffer } of built) {
        const src = ctx.createBufferSource();
        src.buffer = buffer;

        // Per-clip pan pair under the clip's OWN law (mixdown parity).
        const mode: ClipPanNodes['mode'] = buffer.numberOfChannels >= 2 ? 'stereo' : 'mono';
        const panL = ctx.createGain();
        const panR = ctx.createGain();
        const { gL, gR } = mode === 'mono' ? monoPanGains(t.pan) : stereoBalanceGains(t.pan);
        panL.gain.value = gL;
        panR.gain.value = gR;
        panL.connect(merger, 0, 0);
        panR.connect(merger, 0, 1);
        graphNodes.push(panL, panR);
        clipPans.set(c.id, { panL, panR, mode });

        if (mode === 'stereo') {
          // Stereo: channel 0 -> panL, channel 1 -> panR (balance law).
          const splitter = ctx.createChannelSplitter(2);
          src.connect(splitter);
          splitter.connect(panL, 0);
          splitter.connect(panR, 1);
          graphNodes.push(splitter);
        } else {
          // Mono: fan the single channel into both pan gains (constant-power).
          src.connect(panL);
          src.connect(panR);
        }

        const clipEnd = c.startSample + c.lengthSample;
        const when = ctx.currentTime + Math.max(0, (c.startSample - from) / sr);
        const offsetSec = Math.max(0, (from - c.startSample) / sr);
        const durationSec = (clipEnd - Math.max(from, c.startSample)) / sr;
        src.start(when, offsetSec, durationSec);

        sources.push(src);
        endSample = Math.max(endSample, clipEnd);
        if (clipEnd > latestEnd) {
          latestEnd = clipEnd;
          latest = src;
        }
      }
    }

    if (sources.length === 0) {
      // Nothing audible to play — leave the (unused) master disconnected and
      // stay stopped without emitting a spurious transition.
      try {
        master.disconnect();
      } catch {
        // ignore
      }
      this.position = from;
      this._state = 'stopped';
      return;
    }

    // The last-ending source drives the natural-end transition (its clip has the
    // greatest end sample, so it stops last).
    if (latest) latest.onended = () => this.handleEnded();

    this.master = master;
    this.graphNodes = graphNodes;
    this.sources = sources;
    this.playStartSample = from;
    this.position = from;
    this.startedAt = ctx.currentTime;
    this.rate = sr;
    this.endSample = endSample;
    this._state = 'playing';

    if (typeof ctx.resume === 'function') void ctx.resume();
    this.emitState();
  }

  stop(): void {
    const wasActive = this._state !== 'stopped';
    this.teardown();
    if (wasActive) this.position = this.playStartSample;
    this._state = 'stopped';
    if (wasActive) this.emitState();
  }

  getPositionSample(): number {
    if (this._state !== 'playing' || !this.ctx) return this.position;
    const pos = this.playStartSample + (this.ctx.currentTime - this.startedAt) * this.rate;
    return Math.min(pos, this.endSample);
  }

  /**
   * Retro-applies track volume, pan, and mute/solo to the RUNNING graph without
   * rebuilding it — each registered track's `volumeGain`/`muteGain` and every
   * clip's `panL`/`panR` pair (under that clip's OWN pan law) are ramped via
   * `setTargetAtTime` (15 ms). No-op when stopped or for tracks not in the
   * current graph. Solo state is derived from the passed tracks. Clip
   * geometry/gain are baked per source and intentionally NOT handled here.
   */
  applyTrackParams(tracks: Track[]): void {
    const ctx = this.ctx;
    if (!ctx || this._state !== 'playing') return;
    const anySolo = tracks.some((t) => t.solo);
    const now = ctx.currentTime;
    for (const t of tracks) {
      const nodes = this.trackNodes.get(t.id);
      if (!nodes) continue;
      nodes.volumeGain.gain.setTargetAtTime(dbToLinear(t.volumeDb), now, PARAM_SMOOTH);
      const monoG = monoPanGains(t.pan);
      const stereoG = stereoBalanceGains(t.pan);
      for (const pans of nodes.clipPans.values()) {
        const { gL, gR } = pans.mode === 'mono' ? monoG : stereoG;
        pans.panL.gain.setTargetAtTime(gL, now, PARAM_SMOOTH);
        pans.panR.gain.setTargetAtTime(gR, now, PARAM_SMOOTH);
      }
      const target = isEffectivelyMuted(t, anySolo) ? 0 : 1;
      nodes.muteGain.gain.setTargetAtTime(target, now, PARAM_SMOOTH);
    }
  }

  /** Live per-track nodes for the given track id, or `undefined` when the track
   * is not part of the current graph (stopped, or has no audible clips). Exposed
   * for the transport wiring and for tests to assert the graph topology. */
  liveTrackNodes(trackId: string): LiveTrackNodes | undefined {
    return this.trackNodes.get(trackId);
  }

  /** Subscribe to state transitions (including natural end). */
  onStateChange(cb: (state: MultitrackPlayState) => void): () => void {
    this.stateCbs.add(cb);
    return () => {
      this.stateCbs.delete(cb);
    };
  }

  dispose(): void {
    this.teardown();
    this.stateCbs.clear();
    if (this.ctx && typeof this.ctx.close === 'function') void this.ctx.close();
    this.ctx = null;
  }

  // --- internals ----------------------------------------------------------

  private ensureContext(): AudioContext | null {
    if (this.ctx) return this.ctx;
    const create = this.deps.createContext;
    if (create) {
      this.ctx = create() ?? null;
      return this.ctx;
    }
    if (typeof AudioContext === 'undefined') return null;
    this.ctx = new AudioContext();
    return this.ctx;
  }

  /**
   * Builds a session-rate AudioBuffer for a clip, with its gain -- and its
   * fade/crossfade envelope, when it has one -- baked into the samples.
   *
   * Baking is the ONLY player-side fade implementation that can be
   * sample-identical to the offline mixdown (T20): AudioParam automation
   * (`setValueCurveAtTime` and friends) is evaluated on the audio-graph clock
   * with render-quantum interpolation against `ctx.currentTime`, which can
   * never reproduce mixdown's exact per-sample `env(i)`. The envelope factor
   * comes from the SAME `clipFadeGainAt` the mixdown loop multiplies, indexed
   * by the same clip-local sample, so the two paths share every float
   * expression. Baking once into the buffer also applies a mono clip's fade
   * exactly once for both pan sides (the single channel fans into panL AND
   * panR -- a per-channel fade node would double up, T24), and it survives
   * seeking, because a seek is a buffer offset into the same samples.
   *
   * A clip with no envelope and unity gain keeps the untouched-slice path,
   * mirroring mixdown's fade-less loop (ruling 10).
   */
  private buildClipBuffer(
    ctx: AudioContext,
    clip: Clip,
    doc: AudioDocument,
    sessionRate: number,
    fadeSpec?: ClipFadeSpec
  ): AudioBuffer | null {
    const slice = readClipSlice(doc, clip, sessionRate);
    if (slice.length === 0 || slice[0].length === 0) return null;

    const clipGain = dbToLinear(clip.gainDb);
    const len = slice[0].length;
    const buffer = ctx.createBuffer(slice.length, Math.max(1, len), sessionRate);
    for (let c = 0; c < slice.length; c++) {
      let data = slice[c];
      if (clipGain !== 1 || fadeSpec) {
        const scaled = new Float32Array(len);
        if (fadeSpec) {
          for (let i = 0; i < len; i++) scaled[i] = data[i] * clipGain * clipFadeGainAt(fadeSpec, i);
        } else {
          for (let i = 0; i < len; i++) scaled[i] = data[i] * clipGain;
        }
        data = scaled;
      }
      // lib.dom types copyToChannel as Float32Array<ArrayBuffer>; narrow the cast.
      buffer.copyToChannel(data as Float32Array<ArrayBuffer>, c);
    }
    return buffer;
  }

  /** Natural completion: the last source played to its end without a stop. */
  private handleEnded(): void {
    this.teardown();
    this.position = this.playStartSample;
    this._state = 'stopped';
    this.emitState();
  }

  /** Stop + disconnect the whole graph, suppressing onended (manual teardown). */
  private teardown(): void {
    for (const s of this.sources) {
      s.onended = null;
      try {
        s.stop();
      } catch {
        // already stopped / never started
      }
      try {
        s.disconnect();
      } catch {
        // ignore double-disconnect
      }
    }
    this.sources = [];
    for (const n of this.graphNodes) {
      try {
        n.disconnect();
      } catch {
        // ignore
      }
    }
    this.graphNodes = [];
    this.trackNodes.clear();
    this.master = null;
  }

  private emitState(): void {
    for (const cb of this.stateCbs) cb(this._state);
  }
}

/** Shared singleton used by the transport service and the multitrack UI. */
export const multitrackPlayer = new MultitrackPlayer();
