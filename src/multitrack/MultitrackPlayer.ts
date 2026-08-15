import type { AudioDocument } from '../audio/AudioDocument';
import { resolveAutomation, type TrackAutomationSpec } from './automation';
import {
  autoPanGainsAt,
  autoSpatialGainsAt,
  autoVolumeGainAt,
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
 * mixdown applies its law per clip (see `play`). F0 exception: on a track with
 * an active PAN lane the pair is neutralised to unity (the time-varying gains
 * are baked into an always-2-channel buffer — ruling C) and `mode` then
 * describes the promoted BUFFER's routing ('stereo' even for a mono source);
 * the LAW still follows the source channel count, inside the bake.
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
 *
 * F0 additions: `bakedVolume`/`bakedPan` record which parameters were BAKED
 * into this chain's buffers when it was built (an active automation lane,
 * ruling A/B) — `applyTrackParams` must skip those nodes (trap T2: re-pushing
 * the static field would stomp the neutralised unity node under the baked
 * envelope). The flags describe the RUNNING buffers, not the current store
 * state, so they cannot desync mid-play (`refreshTracks` rebuilds chain and
 * flags together). `chainNodes`/`scheduled` are this track's own graph pieces,
 * kept per track so `refreshTracks` can tear down and rebuild ONE track's
 * chain without touching the rest of the running graph (ruling D).
 */
export interface LiveTrackNodes {
  volumeGain: GainNode;
  muteGain: GainNode;
  clipPans: Map<string, ClipPanNodes>;
  bakedVolume: boolean;
  bakedPan: boolean;
  chainNodes: AudioNode[];
  scheduled: { src: AudioBufferSourceNode; clipEnd: number }[];
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
 * Seconds added to the shared scheduling epoch — on a RUNNING context only —
 * so no `start(when)` is already in the past by the time the command queue
 * drains. 10 ms is safe by construction: the slow work (the per-track buffer
 * bakes) happens BEFORE the epoch is read, and the scheduling loop itself is
 * just a handful of `start()` calls — microseconds — so the lead only needs
 * to outlive the command drain, never a bake.
 *
 * A context whose clock is NOT advancing (suspended cold first play, or an
 * OfflineAudioContext before `startRendering`) gets NO lead: a frozen clock
 * cannot move between the epoch read and the command drain, so `when ≥
 * currentTime` already holds — and any lead there is a pure displacement of
 * the entire render/playback against the timeline (the packaged smoke's
 * offline playback≡mixdown comparison measures exactly that axis and failed
 * on an unconditional lead: every sample 10 ms late reads as full-scale
 * error outside a crossfade).
 */
export const SCHEDULE_LEAD = 0.01;

/** One clip's deferred start command: the source is fully built and wired at
 * chain-build time, and `start()` is issued later — against the ONE shared
 * scheduling epoch — so no clock read ever lands between two bakes. */
interface PendingStart {
  src: AudioBufferSourceNode;
  startSample: number;
  clipEnd: number;
}

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
 * SCHEDULING: play() is two-phase. Phase 1 builds every track's chain and
 * bakes every buffer (the slow part) WITHOUT starting anything; phase 2 reads
 * the clock ONCE — `epoch = ctx.currentTime`, plus `SCHEDULE_LEAD` only on a
 * running clock — and starts every source at
 * `epoch + max(0, (clipStart − from)/rate)` in a tight loop,
 * with a mid-clip start offset and the remaining duration, so seeking into
 * the middle of the timeline plays every clip from exactly the right point.
 * One shared epoch means track-to-track alignment derives from startSample
 * deltas only: on a warm context the clock keeps running through the
 * synchronous bakes, and the old per-clip `ctx.currentTime` reads gave every
 * track its own timeline origin (tens of ms of audible skew). Position is
 * derived from `ctx.currentTime` against that same epoch (never a timer) and
 * clamped between the play start and the last clip end.
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
  /** Live per-track node registry, keyed by track id (empty while stopped).
   * Since F0 this is ALSO the ownership registry for teardown: every chain
   * node and every scheduled source lives on its track's entry, so a single
   * track's chain can be torn down and rebuilt in place (`refreshTracks`). */
  private trackNodes = new Map<string, LiveTrackNodes>();

  private _state: MultitrackPlayState = 'stopped';
  /** Sample the current play started from (stop/end return here). */
  private playStartSample = 0;
  /** The shared scheduling epoch of the current play (`ctx.currentTime +
   * SCHEDULE_LEAD`, read once after all builds) — the position pump and the
   * scheduled sources are anchored to the SAME value. */
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
    this.master = master;

    // Phase 1 — the slow part. Build EVERY track's full chain (even muted/
    // solo-excluded ones) so live mute/solo/volume/pan changes can retro-apply
    // to the running graph. A track with no clip past `from` contributes
    // nothing and is skipped. No source is STARTED here: on a warm context
    // the clock keeps running through these synchronous bakes, so a per-clip
    // `ctx.currentTime` read would give every track its own timeline origin,
    // shifted by the JS time spent since the previous track's start commands
    // — the off-beat-tracks bug.
    const pending: PendingStart[] = [];
    for (const t of session.tracks) {
      this.buildTrackChain(ctx, t, sr, docs, anySolo, from, master, pending);
    }

    if (!this.finalizeSchedule()) {
      // Nothing audible to play — leave the (unused) master disconnected and
      // stay stopped without emitting a spurious transition. (No chains were
      // registered either: buildTrackChain only registers when it scheduled.)
      try {
        master.disconnect();
      } catch {
        // ignore
      }
      this.master = null;
      this.position = from;
      this._state = 'stopped';
      return;
    }

    // Phase 2 — the fast part: ONE shared scheduling epoch, read AFTER all
    // builds, so every clip's placement derives from startSample deltas only.
    const epoch = this.schedulingEpoch(ctx);
    this.scheduleSources(pending, epoch, from, sr);

    this.playStartSample = from;
    this.position = from;
    // The playhead is anchored to the SAME epoch the sources are scheduled
    // against, so the visual position agrees with the audio.
    this.startedAt = epoch;
    this.rate = sr;
    this._state = 'playing';

    if (typeof ctx.resume === 'function') void ctx.resume();
    this.emitState();
  }

  /**
   * The shared scheduling epoch: the clock, read once, plus `SCHEDULE_LEAD`
   * only when the clock is actually RUNNING (see the constant's rationale —
   * a frozen clock needs no lead, and a lead on a frozen clock displaces the
   * whole render against the timeline).
   */
  private schedulingEpoch(ctx: AudioContext): number {
    return ctx.currentTime + (ctx.state === 'running' ? SCHEDULE_LEAD : 0);
  }

  /**
   * Phase 2 of `play`/`refreshTracks`: issues every pending `start()` against
   * ONE shared epoch in a tight loop. All relative placement is startSample
   * arithmetic — the clock is never re-read between two starts.
   */
  private scheduleSources(pending: PendingStart[], epoch: number, from: number, sr: number): void {
    for (const p of pending) {
      const when = epoch + Math.max(0, (p.startSample - from) / sr);
      const offsetSec = Math.max(0, (from - p.startSample) / sr);
      const durationSec = (p.clipEnd - Math.max(from, p.startSample)) / sr;
      p.src.start(when, offsetSec, durationSec);
    }
  }

  /**
   * Builds one track's whole chain — baked clip buffers, per-clip pan pairs,
   * merger → volume → mute → `master` — and queues its sources' start
   * commands onto `pending` for timeline sample `from`. It never calls
   * `start()` itself: the caller schedules ALL pending sources against one
   * shared epoch after every track is built, so this function's bake time
   * cannot skew track-to-track alignment. Registers the chain in `trackNodes`
   * (only when at least one source was queued, mirroring the pre-F0 skip of
   * clip-less tracks). Shared verbatim by `play` and `refreshTracks`, so a
   * mid-play automation rebuild cannot drift from the initial build.
   *
   * F0 (rulings A/B/C): the track's active automation is resolved from the
   * SAME `resolveAutomation` the mixdown gates on and handed to
   * `buildClipBuffer`, which bakes the moving parameter(s) into the buffers.
   * A baked parameter's live node is set to UNITY here (the envelope carries
   * the whole value — override, not offset) and its `baked*` flag is recorded
   * so `applyTrackParams` never re-pushes the static field over it (trap T2).
   */
  private buildTrackChain(
    ctx: AudioContext,
    t: Track,
    sr: number,
    docs: Map<string, AudioDocument>,
    anySolo: boolean,
    from: number,
    master: GainNode,
    pending: PendingStart[]
  ): void {
    const auto = resolveAutomation(t.automation);
    // Fades/crossfades resolved from the SAME shared resolver as the offline
    // mixdown, per track, and baked into the buffers below -- so live
    // playback and `mixdownSession` apply identical envelope gains (ruling
    // 4). Resolution is play-position-agnostic: the whole envelope is baked
    // and a seek is just a buffer offset, so it survives seeking like the
    // baked clip gain does. F0's track automation is baked the same way,
    // indexed by TIMELINE sample, so it survives seeking identically.
    const fadeSpecs = resolveClipFadeSpecs(t.clips);
    const built: { clip: Clip; buffer: AudioBuffer }[] = [];
    for (const c of t.clips) {
      if (c.startSample + c.lengthSample <= from) continue;
      const doc = docs.get(c.documentId);
      if (!doc) continue;
      const buffer = this.buildClipBuffer(ctx, c, doc, sr, fadeSpecs.get(c.id), auto);
      if (!buffer) continue;
      built.push({ clip: c, buffer });
    }
    if (built.length === 0) return;

    // Per-track chain: per-clip panL/panR -> shared merger(2) -> volume ->
    // mute -> master. The pan LAW is chosen per clip below, like the mixdown.
    const merger = ctx.createChannelMerger(2);
    const volumeGain = ctx.createGain();
    // Ruling B: an active volume lane is baked into the buffers, so the live
    // node is neutralised to unity — the value must be applied exactly once.
    volumeGain.gain.value = auto?.volume ? 1 : dbToLinear(t.volumeDb);
    const muteGain = ctx.createGain();
    muteGain.gain.value = isEffectivelyMuted(t, anySolo) ? 0 : 1;

    merger.connect(volumeGain);
    volumeGain.connect(muteGain);
    muteGain.connect(master);
    const chainNodes: AudioNode[] = [merger, volumeGain, muteGain];
    const clipPans = new Map<string, ClipPanNodes>();
    const scheduled: LiveTrackNodes['scheduled'] = [];
    this.trackNodes.set(t.id, {
      volumeGain,
      muteGain,
      clipPans,
      bakedVolume: auto?.volume != null,
      // F5: the spatial group bakes into the SAME pan pair a pan lane would
      // (it supersedes pan, ruling 4), so either one marks the pair baked —
      // applyTrackParams must not re-push the static pan over it (trap T2).
      bakedPan: auto?.pan != null || auto?.spatial != null,
      chainNodes,
      scheduled,
    });

    for (const { clip: c, buffer } of built) {
      const src = ctx.createBufferSource();
      src.buffer = buffer;

      // Per-clip pan pair under the clip's OWN law (mixdown parity). With a
      // pan lane — or the F5 spatial group, which supersedes pan (ruling 4)
      // — active, the time-varying gains are already IN the buffer (ruling C
      // — always 2 channels then), so the pair is neutral unity.
      const mode: ClipPanNodes['mode'] = buffer.numberOfChannels >= 2 ? 'stereo' : 'mono';
      const panL = ctx.createGain();
      const panR = ctx.createGain();
      const { gL, gR } =
        auto?.pan || auto?.spatial
          ? { gL: 1, gR: 1 }
          : mode === 'mono'
            ? monoPanGains(t.pan)
            : stereoBalanceGains(t.pan);
      panL.gain.value = gL;
      panR.gain.value = gR;
      panL.connect(merger, 0, 0);
      panR.connect(merger, 0, 1);
      chainNodes.push(panL, panR);
      clipPans.set(c.id, { panL, panR, mode });

      if (mode === 'stereo') {
        // Stereo: channel 0 -> panL, channel 1 -> panR (balance law).
        const splitter = ctx.createChannelSplitter(2);
        src.connect(splitter);
        splitter.connect(panL, 0);
        splitter.connect(panR, 1);
        chainNodes.push(splitter);
      } else {
        // Mono: fan the single channel into both pan gains (constant-power).
        src.connect(panL);
        src.connect(panR);
      }

      const clipEnd = c.startSample + c.lengthSample;
      pending.push({ src, startSample: c.startSample, clipEnd });
      scheduled.push({ src, clipEnd });
    }
  }

  /**
   * Recomputes the natural-end wiring and the `endSample` bound over EVERY
   * scheduled source (shared by `play` and `refreshTracks`): exactly one
   * source — the one whose clip ends last — carries the `onended` callback
   * that drives the natural-end transition; every other source's callback is
   * cleared. Returns false when nothing is scheduled at all.
   */
  private finalizeSchedule(): boolean {
    let latest: AudioBufferSourceNode | null = null;
    let latestEnd = -Infinity;
    for (const tn of this.trackNodes.values()) {
      for (const s of tn.scheduled) {
        s.src.onended = null;
        if (s.clipEnd > latestEnd) {
          latestEnd = s.clipEnd;
          latest = s.src;
        }
      }
    }
    if (!latest) return false;
    latest.onended = () => this.handleEnded();
    this.endSample = latestEnd;
    return true;
  }

  /**
   * F0 ruling D — re-bakes and reschedules the NAMED tracks' chains on the
   * RUNNING graph after an automation edit: tear down that track's sources
   * and nodes, rebuild them from the current play position with the current
   * session's lanes baked in, and leave every other track untouched (an edit
   * rebuilds the affected track's clips, never the session). No-op while
   * stopped — there are no buffers while stopped; the next `play()` bakes
   * from the store anyway. The handover is start-accurate to the scheduling
   * clock, not sample-seamless: the parity guarantee applies to a clean play,
   * and this exists so an edit is HEARD without restarting the transport.
   */
  refreshTracks(
    session: Session,
    docs: Map<string, AudioDocument>,
    trackIds: readonly string[]
  ): void {
    const ctx = this.ctx;
    const master = this.master;
    if (!ctx || !master || this._state !== 'playing') return;
    const anySolo = session.tracks.some((t) => t.solo);
    const from = this.getPositionSample();
    const pending: PendingStart[] = [];
    for (const id of trackIds) {
      const old = this.trackNodes.get(id);
      if (old) {
        for (const { src } of old.scheduled) {
          src.onended = null;
          try {
            src.stop();
          } catch {
            // already stopped / never started
          }
          try {
            src.disconnect();
          } catch {
            // ignore
          }
        }
        for (const n of old.chainNodes) {
          try {
            n.disconnect();
          } catch {
            // ignore
          }
        }
        this.trackNodes.delete(id);
      }
      const t = session.tracks.find((tr) => tr.id === id);
      if (!t) continue;
      this.buildTrackChain(ctx, t, this.rate, docs, anySolo, from, master, pending);
    }
    if (!this.finalizeSchedule()) {
      // Every scheduled source is gone (the refreshed track was the last one
      // sounding and nothing of it remains past the position): natural end.
      this.handleEnded();
      return;
    }
    // Same two-phase discipline as play(): every rebuilt track's sources are
    // scheduled against ONE epoch read after all the rebakes, so a multi-track
    // refresh stays internally aligned. The handover remains scheduled-clock
    // accurate, not sample-seamless (ruling D) — `startedAt` is untouched.
    this.scheduleSources(pending, this.schedulingEpoch(ctx), from, this.rate);
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
    // Clamped below to the play start: while the SCHEDULE_LEAD window has not
    // elapsed (epoch still ahead of the clock) no audio has advanced yet, and
    // the playhead must not sit before the cursor.
    return Math.min(Math.max(pos, this.playStartSample), this.endSample);
  }

  /**
   * Retro-applies track volume, pan, and mute/solo to the RUNNING graph without
   * rebuilding it — each registered track's `volumeGain`/`muteGain` and every
   * clip's `panL`/`panR` pair (under that clip's OWN pan law) are ramped via
   * `setTargetAtTime` (15 ms). No-op when stopped or for tracks not in the
   * current graph. Solo state is derived from the passed tracks. Clip
   * geometry/gain are baked per source and intentionally NOT handled here.
   *
   * F0 (trap T2): a parameter whose envelope is BAKED into this chain's
   * buffers (`bakedVolume`/`bakedPan`, set at build time) is SKIPPED — its
   * node was neutralised to unity and re-pushing the static field here (this
   * fires on EVERY tracks-array write, including edits to unrelated tracks)
   * would stomp the neutralised node and double- or mis-apply the parameter.
   * The lane governs while it has keys (ruling B); the static fader is inert
   * for that parameter until the lane empties and the chain is rebuilt.
   * Mute/solo stay live regardless — mute is a filter, not part of the value.
   */
  applyTrackParams(tracks: Track[]): void {
    const ctx = this.ctx;
    if (!ctx || this._state !== 'playing') return;
    const anySolo = tracks.some((t) => t.solo);
    const now = ctx.currentTime;
    for (const t of tracks) {
      const nodes = this.trackNodes.get(t.id);
      if (!nodes) continue;
      if (!nodes.bakedVolume) {
        nodes.volumeGain.gain.setTargetAtTime(dbToLinear(t.volumeDb), now, PARAM_SMOOTH);
      }
      if (!nodes.bakedPan) {
        const monoG = monoPanGains(t.pan);
        const stereoG = stereoBalanceGains(t.pan);
        for (const pans of nodes.clipPans.values()) {
          const { gL, gR } = pans.mode === 'mono' ? monoG : stereoG;
          pans.panL.gain.setTargetAtTime(gL, now, PARAM_SMOOTH);
          pans.panR.gain.setTargetAtTime(gR, now, PARAM_SMOOTH);
        }
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
    fadeSpec?: ClipFadeSpec,
    auto?: TrackAutomationSpec | null
  ): AudioBuffer | null {
    const slice = readClipSlice(doc, clip, sessionRate);
    if (slice.length === 0 || slice[0].length === 0) return null;

    const clipGain = dbToLinear(clip.gainDb);
    const len = slice[0].length;

    if (auto) {
      // F0 automated bake (rulings A/B/C). The per-sample product is written
      // in the EXACT order mixdown's automated loop multiplies —
      // `sample · clipGain · v · gPan · e` — with the lane factors from the
      // SAME shared `autoVolumeGainAt`/`autoPanGainsAt`, indexed by TIMELINE
      // sample `clip.startSample + i` in both engines (trap T6). A parameter
      // that is NOT automated contributes a literal 1 here (bit-exact
      // identity) and its static value stays on the live node, so the value
      // is applied exactly once either way.
      //
      // Ruling C: with a PAN lane active the buffer is promoted to TWO
      // channels even for a mono source — one buffer channel cannot carry two
      // different time-varying gains (trap T3: the mono fan-out puts
      // different gL/gR on the same samples) — and the MONO constant-power
      // law is baked into the pair. The clip itself stays mono and mixdown
      // still applies the mono law, so which law governs never changes
      // (v1.7: the two laws differ by ~3 dB at centre); only the player's
      // buffer layout does. Cost: 2× buffer memory for mono clips on a
      // pan-automated track — accepted by the ruling.
      const monoSrc = slice.length === 1;
      // F5: the spatial group needs the promoted 2-channel buffer for exactly
      // the reason a pan lane does (one channel cannot carry gL and gR, T3);
      // its gains supersede the pan lane's when both exist (ruling 4), in the
      // SAME three-way order as mixdown's automated loop.
      const outChannels = auto.pan || auto.spatial ? 2 : slice.length;
      const buffer = ctx.createBuffer(outChannels, Math.max(1, len), sessionRate);
      for (let ch = 0; ch < outChannels; ch++) {
        const data = monoSrc ? slice[0] : slice[ch];
        const scaled = new Float32Array(len);
        for (let i = 0; i < len; i++) {
          const s = clip.startSample + i;
          const e = fadeSpec ? clipFadeGainAt(fadeSpec, i) : 1;
          const v = auto.volume ? autoVolumeGainAt(auto.volume, s) : 1;
          let g = 1;
          if (auto.spatial) {
            const p = autoSpatialGainsAt(auto.spatial, s, monoSrc);
            g = ch === 0 ? p.gL : p.gR;
          } else if (auto.pan) {
            const p = autoPanGainsAt(auto.pan, s, monoSrc);
            g = ch === 0 ? p.gL : p.gR;
          }
          scaled[i] = data[i] * clipGain * v * g * e;
        }
        // lib.dom types copyToChannel as Float32Array<ArrayBuffer>.
        buffer.copyToChannel(scaled as Float32Array<ArrayBuffer>, ch);
      }
      return buffer;
    }

    const buffer = ctx.createBuffer(slice.length, Math.max(1, len), sessionRate);
    // Only the actual fade regions take the per-sample envelope pass. The
    // head is the fade-in OR the incoming crossfade (mutually exclusive:
    // `resolveClipFadeSpecs` zeroes `fadeIn` under `crossIn`), the tail the
    // fade-out OR the outgoing crossfade; between them `clipFadeGainAt`
    // returns exactly 1, and ·1 is exact in float, so copying the middle
    // (times the baked clip gain) is byte-identical to running the full
    // per-sample loop — while skipping the envelope calls over the bulk of
    // the clip. That full-length loop was the tens-of-ms bake wedge that sat
    // between two tracks' schedules before the shared epoch existed; now it
    // is just wasted work, removed. Regions are positioned by the SPEC's
    // clip length (a short slice truncates them) and clamped so a
    // pathological spec degrades to per-sample evaluation, never to a wrong
    // middle.
    const headEnd = fadeSpec
      ? Math.min(len, Math.max(fadeSpec.fadeIn, fadeSpec.crossIn?.lengthSample ?? 0))
      : 0;
    const tailStart = fadeSpec
      ? Math.max(
          headEnd,
          Math.min(
            len,
            fadeSpec.lengthSample - Math.max(fadeSpec.fadeOut, fadeSpec.crossOut?.lengthSample ?? 0)
          )
        )
      : len;
    for (let c = 0; c < slice.length; c++) {
      let data = slice[c];
      if (clipGain !== 1 || fadeSpec) {
        const scaled = new Float32Array(len);
        if (fadeSpec) {
          for (let i = 0; i < headEnd; i++) scaled[i] = data[i] * clipGain * clipFadeGainAt(fadeSpec, i);
          if (clipGain !== 1) {
            for (let i = headEnd; i < tailStart; i++) scaled[i] = data[i] * clipGain;
          } else {
            scaled.set(data.subarray(headEnd, tailStart), headEnd);
          }
          for (let i = tailStart; i < len; i++) scaled[i] = data[i] * clipGain * clipFadeGainAt(fadeSpec, i);
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

  /** Stop + disconnect the whole graph, suppressing onended (manual teardown).
   * Everything is owned per track since F0 (see `trackNodes`), plus master. */
  private teardown(): void {
    for (const tn of this.trackNodes.values()) {
      for (const { src } of tn.scheduled) {
        src.onended = null;
        try {
          src.stop();
        } catch {
          // already stopped / never started
        }
        try {
          src.disconnect();
        } catch {
          // ignore double-disconnect
        }
      }
      for (const n of tn.chainNodes) {
        try {
          n.disconnect();
        } catch {
          // ignore
        }
      }
    }
    this.trackNodes.clear();
    if (this.master) {
      try {
        this.master.disconnect();
      } catch {
        // ignore
      }
    }
    this.master = null;
  }

  private emitState(): void {
    for (const cb of this.stateCbs) cb(this._state);
  }
}

/** Shared singleton used by the transport service and the multitrack UI. */
export const multitrackPlayer = new MultitrackPlayer();
