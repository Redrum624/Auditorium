import type { AudioDocument } from '../audio/AudioDocument';
import { readClipSlice } from './mixdown';
import type { Clip, Session, Track } from './session';

export type MultitrackPlayState = 'stopped' | 'playing';

export interface MultitrackPlayerDeps {
  /** Injectable AudioContext factory; tests supply a fake, default builds a real one. */
  createContext?: () => AudioContext;
}

function dbToLinear(db: number): number {
  return Math.pow(10, db / 20);
}

function isAudible(track: Track, anySolo: boolean): boolean {
  return !track.muted && (!anySolo || track.solo);
}

/**
 * Realtime WebAudio playback of a multitrack session. On each `play(fromSample)`
 * the whole graph is rebuilt: one `GainNode` (track volume) → `StereoPannerNode`
 * (track pan) → shared master `GainNode` → destination per audible track, and one
 * `AudioBufferSourceNode` per clip whose end is past `fromSample`. Buffers are
 * built at the SESSION sample rate from the same slice/resample logic as the
 * offline mixdown (`readClipSlice`), with the clip's gain baked in.
 *
 * Sources are scheduled at `ctx.currentTime + max(0, (clipStart − from)/rate)`
 * with a mid-clip start offset and the remaining duration, so seeking into the
 * middle of the timeline plays every clip from exactly the right point. Position
 * is derived from `ctx.currentTime` (never a timer) and clamped to the last
 * clip end.
 *
 * v1 LIMITATIONS (documented):
 *  - Parameter changes (volume/pan/mute/solo, clip moves/trims/gain) during
 *    playback do NOT retro-apply. Stop and play again to hear them.
 *  - The realtime pan uses the WebAudio `StereoPannerNode` law, which differs
 *    slightly from the offline mixdown's constant-power/balance law. The mixdown
 *    is the authoritative render; realtime is a monitoring approximation.
 *  - Buffers are rebuilt every `play()` (no cache); sessions are small in v1.
 */
export class MultitrackPlayer {
  private readonly deps: MultitrackPlayerDeps;

  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  /** Track-level nodes (gains + panners) to disconnect on teardown. */
  private graphNodes: AudioNode[] = [];
  private sources: AudioBufferSourceNode[] = [];

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
    const audible = session.tracks.filter((t) => isAudible(t, anySolo));

    const master = ctx.createGain();
    master.gain.value = 1;
    master.connect(ctx.destination);

    const graphNodes: AudioNode[] = [master];
    const sources: AudioBufferSourceNode[] = [];
    let endSample = from;
    let latest: AudioBufferSourceNode | null = null;
    let latestEnd = -Infinity;

    for (const t of audible) {
      const trackGain = ctx.createGain();
      trackGain.gain.value = dbToLinear(t.volumeDb);
      const panner = this.createPanner(ctx, t.pan);
      trackGain.connect(panner);
      panner.connect(master);
      graphNodes.push(trackGain, panner);

      for (const c of t.clips) {
        const clipEnd = c.startSample + c.lengthSample;
        if (clipEnd <= from) continue;
        const doc = docs.get(c.documentId);
        if (!doc) continue;
        const buffer = this.buildClipBuffer(ctx, c, doc, sr);
        if (!buffer) continue;

        const src = ctx.createBufferSource();
        src.buffer = buffer;
        src.connect(trackGain);

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

  private createPanner(ctx: AudioContext, pan: number): AudioNode {
    if (typeof ctx.createStereoPanner === 'function') {
      const panner = ctx.createStereoPanner();
      panner.pan.value = pan;
      return panner;
    }
    // Environments without StereoPannerNode: fall back to a transparent gain.
    const passthrough = ctx.createGain();
    passthrough.gain.value = 1;
    return passthrough;
  }

  /** Builds a session-rate AudioBuffer for a clip, with its gain baked in. */
  private buildClipBuffer(
    ctx: AudioContext,
    clip: Clip,
    doc: AudioDocument,
    sessionRate: number
  ): AudioBuffer | null {
    const slice = readClipSlice(doc, clip, sessionRate);
    if (slice.length === 0 || slice[0].length === 0) return null;

    const clipGain = dbToLinear(clip.gainDb);
    const len = slice[0].length;
    const buffer = ctx.createBuffer(slice.length, Math.max(1, len), sessionRate);
    for (let c = 0; c < slice.length; c++) {
      let data = slice[c];
      if (clipGain !== 1) {
        const scaled = new Float32Array(len);
        for (let i = 0; i < len; i++) scaled[i] = data[i] * clipGain;
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
    this.master = null;
  }

  private emitState(): void {
    for (const cb of this.stateCbs) cb(this._state);
  }
}

/** Shared singleton used by the transport service and the multitrack UI. */
export const multitrackPlayer = new MultitrackPlayer();
