import { createDocument, docLength, nextId, type AudioDocument } from '../audio/AudioDocument';
import { resampleChannel } from '../dsp/resample';
import { RecordingEngine } from '../audio/RecordingEngine';
import { multitrackPlayer } from './MultitrackPlayer';
import { useSessionStore } from './sessionStore';
import { useAppStore } from '../stores/appStore';
import type { Clip, Session } from './session';

/**
 * Minimal surface the recorder needs from a `RecordingEngine` — start the mic
 * capture and later return the recorded channels + their (device) sample rate.
 * The real `RecordingEngine` satisfies this; tests inject a fake.
 */
export interface RecordingEngineLike {
  start(opts: { deviceId?: string; channels: 1 | 2; sampleRate: number }): Promise<void>;
  stop(): Promise<{ channels: Float32Array[]; sampleRate: number }>;
}

/**
 * Minimal surface the recorder needs from a `MultitrackPlayer` — play the
 * existing session as a monitor track from the punch-in point, and stop.
 */
export interface MultitrackPlayerLike {
  play(fromSample: number, session: Session, docs: Map<string, AudioDocument>): void;
  stop(): void;
}

/** Collaborators for {@link createMultitrackRecorder}. All injectable so the
 * flow can be driven against fakes in jsdom without a real Web Audio backend. */
export interface MultitrackRecorderDeps {
  engine: RecordingEngineLike;
  player: MultitrackPlayerLike;
  getSession: () => Session;
  getDocs: () => Map<string, AudioDocument>;
  getMtCursorSample: () => number;
  addClip: (trackId: string, clip: Clip) => void;
  addDocument: (doc: AudioDocument) => void;
}

export interface MultitrackRecorder {
  isRecording(): boolean;
  start(): Promise<void>;
  stop(): Promise<void>;
  onChange(cb: (recording: boolean) => void): () => void;
}

/**
 * Punch-in multitrack recorder. `start()` plays the existing session (as a
 * monitor) from the multitrack cursor AND records the default input at the
 * session sample rate, concurrently; `stop()` turns the captured audio into a
 * new `Track Recording N` document and drops a clip onto EVERY track that was
 * armed at start time, anchored at the punch-in cursor.
 *
 * DECISION — armed set captured at START, not stop: the clips land on exactly
 * the tracks that were armed when recording began. Arming/disarming a track
 * mid-take does not change where the take is placed, matching a hardware
 * punch-in where the routing is fixed the moment you hit record.
 *
 * The device may capture at a different rate than the session (the browser can
 * ignore the requested `sampleRate`); on stop each channel is resampled to the
 * session rate before the document is created, so the clip length lines up with
 * the session timeline. An empty take (zero recorded samples) creates no
 * document and no clips — it just clears the recording state.
 */
export function createMultitrackRecorder(deps: MultitrackRecorderDeps): MultitrackRecorder {
  let recording = false;
  let punchInSample = 0;
  /** Track ids that were armed at the moment start() was called. */
  let armedTrackIds: string[] = [];
  const cbs = new Set<(recording: boolean) => void>();

  function setRecording(next: boolean): void {
    if (recording === next) return;
    recording = next;
    for (const cb of cbs) cb(recording);
  }

  return {
    isRecording: () => recording,

    async start(): Promise<void> {
      if (recording) return;
      const session = deps.getSession();
      const armed = session.tracks.filter((t) => t.armed);
      if (armed.length === 0) throw new Error('No armed tracks');

      punchInSample = deps.getMtCursorSample();
      armedTrackIds = armed.map((t) => t.id);
      setRecording(true);

      try {
        // Monitor playback (synchronous) AND mic capture (async) start together.
        // If the recorder fails to start, tear the playback back down and surface
        // the error — the caller reports it and no state is left half-armed.
        await Promise.all([
          deps.player.play(punchInSample, session, deps.getDocs()),
          deps.engine.start({ channels: 2, sampleRate: session.sampleRate }),
        ]);
      } catch (err) {
        try {
          deps.player.stop();
        } catch {
          /* ignore */
        }
        setRecording(false);
        throw err;
      }
    },

    async stop(): Promise<void> {
      if (!recording) return;
      deps.player.stop();

      const { channels, sampleRate } = await deps.engine.stop();
      const session = deps.getSession();

      const recorded =
        sampleRate === session.sampleRate
          ? channels
          : channels.map((ch) => resampleChannel(ch, sampleRate, session.sampleRate));

      const length = recorded.length > 0 ? recorded[0].length : 0;
      if (length === 0) {
        // Nothing captured — no document, no clips.
        setRecording(false);
        return;
      }

      const n = nextId('trackrec').split('-')[1];
      const doc = createDocument({
        name: `Track Recording ${n}`,
        sampleRate: session.sampleRate,
        channels: recorded,
      });
      deps.addDocument(doc);

      const lengthSample = docLength(doc);
      for (const trackId of armedTrackIds) {
        deps.addClip(trackId, {
          id: nextId('clip'),
          documentId: doc.id,
          startSample: punchInSample,
          offsetSample: 0,
          lengthSample,
          gainDb: 0,
        });
      }

      setRecording(false);
    },

    onChange(cb): () => void {
      cbs.add(cb);
      return () => {
        cbs.delete(cb);
      };
    },
  };
}

/** Shared singleton wired to the real engine, player, and stores. */
export const multitrackRecorder: MultitrackRecorder = createMultitrackRecorder({
  engine: new RecordingEngine(),
  player: multitrackPlayer,
  getSession: () => useSessionStore.getState().session,
  getDocs: () => new Map(useAppStore.getState().documents.map((d) => [d.id, d])),
  getMtCursorSample: () => useSessionStore.getState().mtCursorSample,
  addClip: (trackId, clip) => useSessionStore.getState().addClip(trackId, clip),
  addDocument: (doc) => useAppStore.getState().addDocument(doc),
});
