import { createDocument, docLength, nextId, type AudioDocument } from '../audio/AudioDocument';
import { resampleChannel } from '../dsp/resample';
import { RecordingEngine } from '../audio/RecordingEngine';
import { multitrackPlayer } from './MultitrackPlayer';
import { useSessionStore } from './sessionStore';
import { withSessionGesture } from './sessionUndo';
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
 * Lifecycle of a take. Every transition is claimed SYNCHRONOUSLY (before any
 * await) so concurrent calls can never both pass a guard:
 *   idle → starting  (start(): claim, then build monitor graph + mic capture)
 *   starting → recording  (both engines up)
 *   starting → idle  (engine failed; monitor rolled back)
 *   recording → stopping  (stop(): claim, then flush + commit the take)
 *   stopping → idle  (take committed / discarded)
 * A stop() that arrives during 'starting' (e.g. while the permission prompt is
 * open) waits for the in-flight start to settle and then runs the normal stop
 * path, so the mic is never left live behind a half-torn-down state.
 */
type RecorderState = 'idle' | 'starting' | 'recording' | 'stopping';

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
 * DECISION — stop() during an in-flight start() COMMITS rather than aborts: it
 * waits for the start to settle, then runs the normal stop path (usually an
 * empty or near-empty take, which creates nothing). Aborting would race the
 * engine's own setup/rollback; waiting keeps exactly one owner for teardown.
 *
 * The device may capture at a different rate than the session (the browser can
 * ignore the requested `sampleRate`); on stop each channel is resampled to the
 * session rate before the document is created, so the clip length lines up with
 * the session timeline. An empty take (zero recorded samples) creates no
 * document and no clips — it just clears the recording state.
 */
export function createMultitrackRecorder(deps: MultitrackRecorderDeps): MultitrackRecorder {
  let state: RecorderState = 'idle';
  let punchInSample = 0;
  /** Track ids that were armed at the moment start() was called. */
  let armedTrackIds: string[] = [];
  /** In-flight start (rejections swallowed), awaited by a stop() that lands in
   * the 'starting' window. */
  let startPromise: Promise<void> | null = null;
  const cbs = new Set<(recording: boolean) => void>();

  /** Transition helper: notifies subscribers only when the PUBLIC boolean
   * (idle vs any active state) actually flips. */
  function setState(next: RecorderState): void {
    const wasOn = state !== 'idle';
    state = next;
    const isOn = state !== 'idle';
    if (wasOn !== isOn) for (const cb of cbs) cb(isOn);
  }

  return {
    isRecording: () => state !== 'idle',

    async start(): Promise<void> {
      if (state !== 'idle') return;
      const session = deps.getSession();
      const armed = session.tracks.filter((t) => t.armed);
      if (armed.length === 0) throw new Error('No armed tracks');

      punchInSample = deps.getMtCursorSample();
      armedTrackIds = armed.map((t) => t.id);
      // Claim the take synchronously so a second start() (or a stop()) issued
      // in the async window below can't interleave with graph setup.
      setState('starting');

      const run = (async () => {
        try {
          // Monitor playback (synchronous) AND mic capture (async) start
          // together. If the recorder fails to start, tear the playback back
          // down and surface the error — no state is left half-armed.
          await Promise.all([
            deps.player.play(punchInSample, session, deps.getDocs()),
            deps.engine.start({ channels: 2, sampleRate: session.sampleRate }),
          ]);
          setState('recording');
        } catch (err) {
          try {
            deps.player.stop();
          } catch {
            /* ignore */
          }
          setState('idle');
          throw err;
        }
      })();
      // The swallowed twin exists solely for stop() to sequence against; the
      // caller still receives the real rejection via the await below.
      startPromise = run.catch(() => undefined);
      await run;
    },

    async stop(): Promise<void> {
      if (state === 'idle' || state === 'stopping') return;

      if (state === 'starting') {
        // Landed inside the permission-prompt window: wait for the in-flight
        // start to settle so the capture graph is either fully up (proceed to
        // a normal stop) or fully rolled back (nothing to do). See the
        // stop-during-start DECISION above.
        await startPromise;
        if ((state as RecorderState) !== 'recording') return; // start failed, or another stop won
      }

      // Claim the commit synchronously — a second stop() arriving while
      // engine.stop() is awaited below returns at the guard above instead of
      // double-committing the take.
      setState('stopping');
      startPromise = null;
      deps.player.stop();

      try {
        const { channels, sampleRate } = await deps.engine.stop();
        const session = deps.getSession();

        const recorded =
          sampleRate === session.sampleRate
            ? channels
            : channels.map((ch) => resampleChannel(ch, sampleRate, session.sampleRate));

        const length = recorded.length > 0 ? recorded[0].length : 0;
        if (length === 0) return; // nothing captured — no document, no clips

        const n = nextId('trackrec').split('-')[1];
        const doc = createDocument({
          name: `Track Recording ${n}`,
          sampleRate: session.sampleRate,
          channels: recorded,
        });
        deps.addDocument(doc);

        const lengthSample = docLength(doc);
        // R3: one recording stop is ONE undo step — N armed tracks land N
        // clips, and undoing the take must lift all of them together, not one
        // per Ctrl+Z. The gesture bracket folds the per-track addClip commits
        // (each recorded inside the store) into a single session entry.
        withSessionGesture(armedTrackIds.length === 1 ? 'Record clip' : 'Record clips', () => {
          for (const trackId of armedTrackIds) {
            // The clip lands verbatim at the punch-in cursor — same convention as
            // insertActiveDocAsClip (menuActions): overlap is first-class (X5)
            // and a programmatic placement never writes fade keys, so a take
            // over an existing clip lands as a raw overlap and the user shapes
            // it afterwards — drag a clip to arm a crossfade over the overlap,
            // or Ctrl-drag to push it clear (sessionStore's overlap contract).
            deps.addClip(trackId, {
              id: nextId('clip'),
              documentId: doc.id,
              startSample: punchInSample,
              offsetSample: 0,
              lengthSample,
              gainDb: 0,
            });
          }
        });
      } finally {
        setState('idle');
      }
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
  // This engine is a second, independent RecordingEngine instance — RecordDialog
  // (src/components/Dialogs/RecordDialog.tsx) owns its own for single-document
  // recording. The two never contend for the mic today only because RecordDialog
  // is rendered modally (the multitrack Record button and its dialog can't both
  // be driving input at once). If RecordDialog ever becomes non-modal, this
  // engine and that one need a shared mic-ownership gate to prevent both from
  // opening the input device concurrently.
  engine: new RecordingEngine(),
  player: multitrackPlayer,
  getSession: () => useSessionStore.getState().session,
  getDocs: () => new Map(useAppStore.getState().documents.map((d) => [d.id, d])),
  getMtCursorSample: () => useSessionStore.getState().mtCursorSample,
  addClip: (trackId, clip) => useSessionStore.getState().addClip(trackId, clip),
  addDocument: (doc) => useAppStore.getState().addDocument(doc),
});
