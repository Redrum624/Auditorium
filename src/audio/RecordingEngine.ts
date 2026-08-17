import { RECORDER_WORKLET_SOURCE } from './recorderWorklet';

/** A discovered audio input device (label may be empty before permission). */
export interface AudioInput {
  deviceId: string;
  label: string;
}

export interface RecordStartOptions {
  deviceId?: string;
  channels: 1 | 2;
  sampleRate: number;
}

export interface RecordResult {
  channels: Float32Array[];
  sampleRate: number;
}

// --- Structural "…Like" surfaces --------------------------------------------
// The engine works against these minimal shapes so jsdom tests can inject fakes
// without a real Web Audio backend; the default deps bridge to the real DOM
// types via casts (see the constructor).

interface AudioNodeLike {
  connect(destination: unknown): unknown;
  disconnect(): void;
}

interface GainLike extends AudioNodeLike {
  gain: { value: number };
}

export interface RecordingContextLike {
  readonly sampleRate: number;
  destination?: unknown;
  audioWorklet: { addModule(moduleUrl: string): Promise<void> };
  createMediaStreamSource(stream: MediaStream): AudioNodeLike;
  createGain?(): GainLike;
  close?(): Promise<void>;
}

export interface WorkletNodeLike {
  port: {
    postMessage(message: unknown, transfer?: Transferable[]): void;
    onmessage: ((ev: { data: unknown }) => void) | null;
  };
  connect(destination: unknown): unknown;
  disconnect(): void;
}

/** Message posted by the worklet back to the engine (one entry per channel). */
interface WorkletChunk {
  channels: Float32Array[];
  final: boolean;
}

export interface RecordingEngineDeps {
  getUserMedia?: (constraints: MediaStreamConstraints) => Promise<MediaStream>;
  enumerateDevices?: () => Promise<MediaDeviceInfo[]>;
  createContext?: (sampleRate: number) => RecordingContextLike;
  createWorkletNode?: (ctx: RecordingContextLike, name: string) => WorkletNodeLike;
  createModuleUrl?: (source: string) => string;
}

const WORKLET_NAME = 'recorder';
const MIN_DB = -60;
/** Safety net so a wedged worklet can't hang stop() forever. */
const FLUSH_TIMEOUT_MS = 3000;

/**
 * Records the microphone into per-channel Float32Array buffers via an
 * AudioWorklet. The graph is `MediaStreamAudioSourceNode → AudioWorkletNode`;
 * the worklet node is additionally routed through a zero-gain GainNode to
 * `ctx.destination`. That keep-alive tap is silent (gain 0, so no feedback to
 * the speakers) but guarantees the worklet is pulled by the render thread on
 * platforms that only run a processor whose output reaches the destination.
 * The mic is released on stop() by stopping every MediaStreamTrack and closing
 * the AudioContext.
 */
export class RecordingEngine {
  private readonly getUserMedia: (c: MediaStreamConstraints) => Promise<MediaStream>;
  private readonly enumerateDevices?: () => Promise<MediaDeviceInfo[]>;
  private readonly createContext: (sampleRate: number) => RecordingContextLike;
  private readonly createWorkletNode: (ctx: RecordingContextLike, name: string) => WorkletNodeLike;
  private readonly createModuleUrl: (source: string) => string;

  private _isRecording = false;
  private stream: MediaStream | null = null;
  private ctx: RecordingContextLike | null = null;
  private source: AudioNodeLike | null = null;
  private node: WorkletNodeLike | null = null;
  private keepAlive: GainLike | null = null;

  /** Accumulated per-channel chunks (index = channel). */
  private chunks: Float32Array[][] = [];
  private requestedChannels = 1;
  private resolveFinal: (() => void) | null = null;

  private readonly levelCbs = new Set<(peakDb: number) => void>();

  constructor(deps: RecordingEngineDeps = {}) {
    this.getUserMedia =
      deps.getUserMedia ??
      ((c) => navigator.mediaDevices.getUserMedia(c));
    this.enumerateDevices = deps.enumerateDevices;
    this.createContext =
      deps.createContext ??
      ((sr) =>
        new AudioContext({ sampleRate: sr }) as unknown as RecordingContextLike);
    this.createWorkletNode =
      deps.createWorkletNode ??
      ((ctx, name) =>
        new AudioWorkletNode(
          ctx as unknown as BaseAudioContext,
          name
        ) as unknown as WorkletNodeLike);
    this.createModuleUrl =
      deps.createModuleUrl ??
      ((source) =>
        URL.createObjectURL(new Blob([source], { type: 'application/javascript' })));
  }

  get isRecording(): boolean {
    return this._isRecording;
  }

  /** Enumerate audio input devices. Labels may be empty before permission is
   * granted; callers show a 'Microphone N' fallback. Returns [] when device
   * enumeration is unavailable (e.g. jsdom / no mediaDevices). */
  async listInputs(): Promise<AudioInput[]> {
    const enumerate =
      this.enumerateDevices ??
      (typeof navigator !== 'undefined' && navigator.mediaDevices?.enumerateDevices
        ? () => navigator.mediaDevices.enumerateDevices()
        : null);
    if (!enumerate) return [];
    const devices = await enumerate();
    return devices
      .filter((d) => d.kind === 'audioinput')
      .map((d) => ({ deviceId: d.deviceId, label: d.label }));
  }

  /** Subscribe to per-batch peak-dB updates. Returns an unsubscribe function. */
  onLevel(cb: (peakDb: number) => void): () => void {
    this.levelCbs.add(cb);
    return () => {
      this.levelCbs.delete(cb);
    };
  }

  async start(opts: RecordStartOptions): Promise<void> {
    if (this._isRecording) throw new Error('Already recording');
    // Claim the recording slot synchronously so two rapid start() calls can't
    // both pass the guard; release it if setup fails.
    this._isRecording = true;
    this.requestedChannels = opts.channels;
    this.chunks = [];

    // Declared outside the try so the catch can release resources acquired
    // BEFORE the failing step — e.g. getUserMedia succeeded (mic indicator on)
    // but addModule then rejected. Without this the mic stays lit and every
    // retry leaks another AudioContext.
    let stream: MediaStream | null = null;
    let ctx: RecordingContextLike | null = null;
    try {
      const audio: MediaTrackConstraints = { channelCount: opts.channels };
      if (opts.deviceId) audio.deviceId = { exact: opts.deviceId };
      stream = await this.getUserMedia({ audio });

      ctx = this.createContext(opts.sampleRate);
      const moduleUrl = this.createModuleUrl(RECORDER_WORKLET_SOURCE);
      try {
        await ctx.audioWorklet.addModule(moduleUrl);
      } finally {
        // The module URL is a one-shot object URL (blob:); once addModule has
        // resolved or rejected it's no longer needed, so free it immediately
        // rather than leaking it for the life of the page. Guarded for jsdom /
        // injected fake URLs where revokeObjectURL may not exist.
        try {
          URL.revokeObjectURL?.(moduleUrl);
        } catch {
          /* ignore */
        }
      }

      const source = ctx.createMediaStreamSource(stream);
      const node = this.createWorkletNode(ctx, WORKLET_NAME);
      node.port.onmessage = (ev) => this.handleChunk(ev.data as WorkletChunk);
      source.connect(node);

      // Silent keep-alive tap (gain 0) so the processor is pulled by the render
      // thread even though we never want its audio at the speakers.
      if (ctx.createGain && ctx.destination) {
        const gain = ctx.createGain();
        gain.gain.value = 0;
        node.connect(gain);
        gain.connect(ctx.destination);
        this.keepAlive = gain;
      }

      this.stream = stream;
      this.ctx = ctx;
      this.source = source;
      this.node = node;
    } catch (err) {
      this._isRecording = false;
      this.disposeGraph();
      // Release the mic and the context created before the failure.
      try {
        stream?.getTracks().forEach((t) => t.stop());
      } catch {
        /* ignore */
      }
      if (ctx?.close) {
        try {
          await ctx.close();
        } catch {
          /* ignore */
        }
      }
      throw err;
    }
  }

  async stop(): Promise<RecordResult> {
    if (!this._isRecording) throw new Error('Not recording');
    const ctx = this.ctx;
    const node = this.node;

    // Flush the worklet's remaining frames, waiting for its final batch.
    await new Promise<void>((resolve) => {
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.resolveFinal = null;
        resolve();
      };
      this.resolveFinal = done;
      const timer = setTimeout(done, FLUSH_TIMEOUT_MS);
      if (node) node.port.postMessage('flush');
      else done();
    });

    const sampleRate = ctx?.sampleRate ?? 44100;
    // EVERY teardown step lives in the `finally` below. `concatChannels()`
    // allocates one merged buffer per channel and can therefore throw
    // (RangeError/OOM on a long take); without the `finally` that throw left
    // the mic TRACK LIVE (recording indicator stuck on), the AudioContext
    // open, the worklet graph connected, the raw per-batch `chunks` retained,
    // and `_isRecording` true — so the engine could never be started again
    // and the only fix was restarting the app.
    try {
      const channels = this.concatChannels();
      return { channels, sampleRate };
    } finally {
      // Release the accumulated raw per-batch arrays now that they've been
      // copied into `channels` — otherwise the previous take's chunks stayed
      // retained via `this.chunks` until the next start() call reset it, i.e.
      // for the rest of the session if the user never records again (Task M9 /
      // F29). On the throw path this matters even more: the merge failed
      // BECAUSE the accumulation is huge.
      this.chunks = [];

      this.disposeGraph();
      // Stop tracks (releases the mic) and close the context.
      this.stream?.getTracks().forEach((t) => t.stop());
      if (ctx?.close) {
        try {
          await ctx.close();
        } catch {
          // Already closed / unsupported; ignore.
        }
      }

      this.stream = null;
      this.ctx = null;
      this._isRecording = false;
    }
  }

  // --- internals ------------------------------------------------------------

  private handleChunk(chunk: WorkletChunk): void {
    if (!chunk || !Array.isArray(chunk.channels)) return;
    const { channels } = chunk;

    if (this.chunks.length === 0 && channels.length > 0) {
      this.chunks = channels.map(() => []);
    }
    for (let c = 0; c < channels.length && c < this.chunks.length; c++) {
      this.chunks[c].push(channels[c]);
    }

    this.emitLevel(channels);

    if (chunk.final) this.resolveFinal?.();
  }

  private emitLevel(channels: Float32Array[]): void {
    if (this.levelCbs.size === 0) return;
    let peak = 0;
    for (const ch of channels) {
      for (let i = 0; i < ch.length; i++) {
        const v = Math.abs(ch[i]);
        if (v > peak) peak = v;
      }
    }
    const db = peak > 0 ? Math.max(MIN_DB, 20 * Math.log10(peak)) : MIN_DB;
    for (const cb of this.levelCbs) cb(db);
  }

  /** Concatenate accumulated chunks into one Float32Array per channel, clamped
   * to the first two.
   *
   * The COUNT follows the DEVICE, not the request. `opts.channels` is passed as
   * a bare `channelCount` constraint, which is `ideal`, not `exact` — a mono
   * interface asked for 2 returns 1, and a device that only opens in stereo
   * asked for 1 returns 2 (clamped here at 2). The worklet's first chunk sizes
   * `this.chunks`, so whatever the device delivered is what comes out. Only the
   * no-chunk-ever-arrived case falls back to the requested count, and then
   * every array is empty. Consumers must therefore treat the result as 1-or-2
   * channels regardless of what they asked for: all of them do today
   * (`RecordDialog`, `multitrackRecord`, `AlignLyricsDialog` and the test hooks
   * all iterate or read `[0]`, and a mono document is first-class everywhere
   * downstream), and any future consumer that indexes `[1]` unconditionally
   * would be reading `undefined`. */
  private concatChannels(): Float32Array[] {
    let sources = this.chunks;
    if (sources.length === 0) {
      sources = Array.from({ length: this.requestedChannels }, () => []);
    }
    const kept = sources.slice(0, 2);
    return kept.map((blocks) => {
      let length = 0;
      for (const b of blocks) length += b.length;
      const merged = new Float32Array(length);
      let offset = 0;
      for (const b of blocks) {
        merged.set(b, offset);
        offset += b.length;
      }
      return merged;
    });
  }

  private disposeGraph(): void {
    try {
      this.source?.disconnect();
    } catch {
      /* ignore */
    }
    try {
      this.node?.disconnect();
    } catch {
      /* ignore */
    }
    try {
      this.keepAlive?.disconnect();
    } catch {
      /* ignore */
    }
    if (this.node) this.node.port.onmessage = null;
    this.source = null;
    this.node = null;
    this.keepAlive = null;
  }
}
