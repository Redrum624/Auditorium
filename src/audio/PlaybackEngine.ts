import type { AudioDocument } from './AudioDocument';
import { docLength } from './AudioDocument';

/** A half-open sample region `[start, end)`, mirroring the store's SelectionRange. */
export interface PlaybackRegion {
  start: number;
  end: number;
}

export type PlaybackState = 'stopped' | 'playing' | 'paused';

export interface PlaybackPlayOptions {
  /** Loop this region indefinitely (Audition selection-loop behavior). */
  loopRegion?: PlaybackRegion | null;
  /** Play this region once, then auto-stop (bounded selection playback). */
  playRegion?: PlaybackRegion | null;
}

export interface PlaybackEngineDeps {
  /** Injectable AudioContext factory; tests supply a fake, default builds a real one. */
  createContext?: () => AudioContext;
}

/** Level-metering cadence in ms (~30 Hz) and analyser window size. */
const LEVEL_INTERVAL_MS = 33;
const FFT_SIZE = 2048;
const MIN_DB = -60;

/**
 * Owns audio playback for a single active document. The graph is
 * `source → gain(master) → destination` plus `source → splitter → analyser[]`
 * taps for level metering. The AudioContext is created lazily (first load/play)
 * so the class is inert until playback is actually requested; in environments
 * without Web Audio (jsdom) every method no-ops safely.
 *
 * Position is derived from `ctx.currentTime`, never from a timer, so it stays
 * sample-accurate; while looping it is folded back into the loop region. State
 * transitions are broadcast via `onStateChange` so the UI can mirror the
 * engine (the source of truth) into the store, including on natural end.
 */
export class PlaybackEngine {
  private readonly deps: PlaybackEngineDeps;

  private ctx: AudioContext | null = null;
  private gain: GainNode | null = null;
  private splitter: ChannelSplitterNode | null = null;
  private analysers: AnalyserNode[] = [];
  /** Per-channel scratch buffers reused by pollLevels (sized to fftSize). */
  private levelBuffers: Float32Array<ArrayBuffer>[] = [];

  private buffer: AudioBuffer | null = null;
  private meta: { sampleRate: number; length: number; channelCount: number } | null = null;
  private source: AudioBufferSourceNode | null = null;
  /** `id` of the AudioDocument last passed to `load()`, cleared by `unload()`/
   * `dispose()`. Lets callers (fileService's closeDocumentFlow) tell whether
   * the document they're closing is the one currently resident in the engine
   * (Task M9 / F16). */
  private loadedDocId: string | null = null;

  private _state: PlaybackState = 'stopped';
  /** Sample the current source was started from (stop/end return here). */
  private startSample = 0;
  /** `ctx.currentTime` captured at source.start, for position derivation. */
  private startedAt = 0;
  /** Stored position used while stopped/paused. */
  private position = 0;
  /** Active loop region (samples) or null when playing straight through. */
  private loopRegion: PlaybackRegion | null = null;
  /** Upper sample bound of a non-looping play (region end or document end). */
  private endSample = 0;

  private levelTimer: ReturnType<typeof setInterval> | null = null;
  private readonly levelCbs = new Set<(peakDbPerChannel: number[]) => void>();
  private readonly stateCbs = new Set<(state: PlaybackState) => void>();

  constructor(deps?: PlaybackEngineDeps) {
    this.deps = deps ?? {};
  }

  get state(): PlaybackState {
    return this._state;
  }

  /** `id` of the document currently resident in the engine (buffer + meta), or
   * `null` once unloaded/disposed. */
  get loadedDocumentId(): string | null {
    return this.loadedDocId;
  }

  /** (Re)prepare the playback buffer for `doc`, stopping any current playback. */
  load(doc: AudioDocument): void {
    this.stop();
    const ctx = this.ensureContext();
    const length = docLength(doc);
    const channelCount = doc.channels.length;
    this.meta = { sampleRate: doc.sampleRate, length, channelCount };
    this.loadedDocId = doc.id;
    this.position = 0;
    this.startSample = 0;
    if (!ctx) {
      this.buffer = null;
      return;
    }
    const buffer = ctx.createBuffer(channelCount, Math.max(1, length), doc.sampleRate);
    for (let c = 0; c < channelCount; c++) {
      // lib.dom types copyToChannel as Float32Array<ArrayBuffer>; the document's
      // channels are typed Float32Array<ArrayBufferLike>, hence the narrowing cast.
      buffer.copyToChannel(doc.channels[c] as Float32Array<ArrayBuffer>, c);
    }
    this.buffer = buffer;
    this.buildGraph(ctx, channelCount);
  }

  play(fromSample: number, opts: PlaybackPlayOptions = {}): void {
    const ctx = this.ensureContext();
    if (!ctx || !this.buffer || !this.meta || !this.gain || !this.splitter) return;

    this.teardownSource();

    const sr = this.meta.sampleRate;
    const loopRegion = opts.loopRegion ?? null;
    const playRegion = opts.playRegion ?? null;
    let offset = Math.max(0, Math.floor(fromSample));
    let duration: number | undefined;

    const source = ctx.createBufferSource();
    source.buffer = this.buffer;
    source.connect(this.gain);
    source.connect(this.splitter);

    if (loopRegion) {
      source.loop = true;
      source.loopStart = loopRegion.start / sr;
      source.loopEnd = loopRegion.end / sr;
      // Starting outside the loop region snaps to its start (Audition behavior).
      if (offset < loopRegion.start || offset >= loopRegion.end) {
        offset = loopRegion.start;
      }
      this.endSample = this.meta.length;
    } else if (playRegion) {
      duration = Math.max(0, playRegion.end - offset) / sr;
      this.endSample = playRegion.end;
    } else {
      this.endSample = this.meta.length;
    }

    source.onended = () => this.handleEnded();
    this.source = source;
    this.loopRegion = loopRegion;
    this.startSample = offset;
    this.position = offset;
    this.startedAt = ctx.currentTime;
    this._state = 'playing';

    if (typeof ctx.resume === 'function') void ctx.resume();
    source.start(0, offset / sr, duration);
    this.startLevelPolling();
    this.emitState();
  }

  pause(): void {
    if (this._state !== 'playing') return;
    this.position = this.getPositionSample();
    this.teardownSource();
    this.stopLevelPolling();
    this._state = 'paused';
    this.emitState();
  }

  stop(): void {
    const wasActive = this._state !== 'stopped';
    this.teardownSource();
    this.stopLevelPolling();
    if (wasActive) this.position = this.startSample;
    this.loopRegion = null;
    this._state = 'stopped';
    if (wasActive) this.emitState();
  }

  seek(sample: number): void {
    const target = Math.max(0, Math.floor(sample));
    this.position = target;
    this.startSample = target;
    if (this._state === 'playing') {
      this.play(target, { loopRegion: this.loopRegion });
    }
  }

  getPositionSample(): number {
    if (this._state !== 'playing' || !this.ctx || !this.meta) return this.position;
    const sr = this.meta.sampleRate;
    let pos = this.startSample + (this.ctx.currentTime - this.startedAt) * sr;
    if (this.loopRegion) {
      const { start, end } = this.loopRegion;
      const span = end - start;
      if (span > 0) {
        pos = start + (((pos - start) % span) + span) % span;
      }
    } else {
      pos = Math.min(pos, this.endSample);
    }
    return pos;
  }

  /** Subscribe to ~30 Hz peak-dB updates (one entry per channel). */
  onLevel(cb: (peakDbPerChannel: number[]) => void): () => void {
    this.levelCbs.add(cb);
    return () => {
      this.levelCbs.delete(cb);
    };
  }

  /** Subscribe to state transitions (including natural end). */
  onStateChange(cb: (state: PlaybackState) => void): () => void {
    this.stateCbs.add(cb);
    return () => {
      this.stateCbs.delete(cb);
    };
  }

  /** Stops playback and releases the loaded buffer/meta (the retained
   * AudioBuffer's PCM) while keeping the AudioContext — and its gain/splitter/
   * analyser graph — alive for a subsequent `load()`. `stop()` alone leaves
   * `buffer`/`meta` populated (only `dispose()` released them, and `dispose()`
   * has no production callers), so the last-closed document's full decoded
   * audio stayed resident in memory for the rest of the session (Task M9 /
   * F16). Call this instead of `stop()` when the document being closed is the
   * one currently loaded (or when no documents remain open at all). */
  unload(): void {
    this.stop();
    this.buffer = null;
    this.meta = null;
    this.loadedDocId = null;
    this.position = 0;
    this.startSample = 0;
    this.endSample = 0;
  }

  dispose(): void {
    this.teardownSource();
    this.stopLevelPolling();
    this.gain?.disconnect();
    this.splitter?.disconnect();
    for (const a of this.analysers) a.disconnect();
    this.analysers = [];
    this.levelBuffers = [];
    this.gain = null;
    this.splitter = null;
    this.levelCbs.clear();
    this.stateCbs.clear();
    if (this.ctx && typeof this.ctx.close === 'function') void this.ctx.close();
    this.ctx = null;
    this.buffer = null;
    this.meta = null;
    this.loadedDocId = null;
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

  private buildGraph(ctx: AudioContext, channelCount: number): void {
    this.gain?.disconnect();
    this.splitter?.disconnect();
    for (const a of this.analysers) a.disconnect();

    const gain = ctx.createGain();
    gain.gain.value = 1.0;
    gain.connect(ctx.destination);

    const splitter = ctx.createChannelSplitter(channelCount);
    const analysers: AnalyserNode[] = [];
    for (let c = 0; c < channelCount; c++) {
      const analyser = ctx.createAnalyser();
      analyser.fftSize = FFT_SIZE;
      splitter.connect(analyser, c, 0);
      analysers.push(analyser);
    }

    this.gain = gain;
    this.splitter = splitter;
    this.analysers = analysers;
    // Reusable per-channel scratch buffers for level polling — allocating
    // a Float32Array(fftSize) per channel every 33ms would churn the GC.
    this.levelBuffers = analysers.map((a) => new Float32Array(a.fftSize));
  }

  /** Natural completion: source played to its end without a manual stop. */
  private handleEnded(): void {
    this.detachSource();
    this.stopLevelPolling();
    this.position = this.startSample;
    this.loopRegion = null;
    this._state = 'stopped';
    this.emitState();
  }

  /** Stop and detach the source, suppressing its onended (manual teardown). */
  private teardownSource(): void {
    const s = this.source;
    if (!s) return;
    // Null onended BEFORE stop(): Web Audio fires onended on manual stop too,
    // and a manual teardown must never be handled as a natural end.
    s.onended = null;
    this.source = null;
    try {
      s.stop();
    } catch {
      // Already stopped / never started; ignore.
    }
    try {
      s.disconnect();
    } catch {
      // Ignore double-disconnect.
    }
  }

  /** Detach the source without stopping it (it already ended on its own). */
  private detachSource(): void {
    const s = this.source;
    if (!s) return;
    s.onended = null;
    this.source = null;
    try {
      s.disconnect();
    } catch {
      // Ignore.
    }
  }

  private startLevelPolling(): void {
    if (this.levelTimer !== null || this.analysers.length === 0) return;
    this.levelTimer = setInterval(() => this.pollLevels(), LEVEL_INTERVAL_MS);
  }

  private stopLevelPolling(): void {
    if (this.levelTimer === null) return;
    clearInterval(this.levelTimer);
    this.levelTimer = null;
  }

  private pollLevels(): void {
    if (this.levelCbs.size === 0) return;
    const peaks = this.analysers.map((analyser, i) => {
      const buf = this.levelBuffers[i];
      analyser.getFloatTimeDomainData(buf);
      let peak = 0;
      for (let i = 0; i < buf.length; i++) {
        const v = Math.abs(buf[i]);
        if (v > peak) peak = v;
      }
      const db = peak > 0 ? 20 * Math.log10(peak) : MIN_DB;
      return Math.max(MIN_DB, db);
    });
    for (const cb of this.levelCbs) cb(peaks);
  }

  private emitState(): void {
    for (const cb of this.stateCbs) cb(this._state);
  }
}

/** Shared singleton used by the transport UI and commands. */
export const playbackEngine = new PlaybackEngine();
