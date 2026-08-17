import {
  createMultitrackRecorder,
  type MultitrackPlayerLike,
  type MultitrackRecorderDeps,
  type RecordingEngineLike,
} from './multitrackRecord';
import { useSessionStore } from './sessionStore';
import { makeInitialState, useAppStore } from '../stores/appStore';
import * as resampleModule from '../dsp/resample';

type EngineResult = { channels: Float32Array[]; sampleRate: number };

function fakeEngine(result: EngineResult): RecordingEngineLike & { start: jest.Mock; stop: jest.Mock } {
  return {
    start: jest.fn(async () => {}),
    stop: jest.fn(async () => result),
  };
}

function spyPlayer(): MultitrackPlayerLike & { play: jest.Mock; stop: jest.Mock } {
  return { play: jest.fn(), stop: jest.fn() };
}

/** Recorder wired to the REAL stores (like transportService's singleton) but
 * with an injected fake engine and spy player, so we can assert the resulting
 * session/document state end-to-end. */
function makeRecorder(
  engine: RecordingEngineLike,
  player: MultitrackPlayerLike
): ReturnType<typeof createMultitrackRecorder> {
  const deps: MultitrackRecorderDeps = {
    engine,
    player,
    getSession: () => useSessionStore.getState().session,
    getDocs: () => new Map(useAppStore.getState().documents.map((d) => [d.id, d])),
    getMtCursorSample: () => useSessionStore.getState().mtCursorSample,
    addClip: (trackId, clip) => useSessionStore.getState().addClip(trackId, clip),
    addDocument: (doc) => useAppStore.getState().addDocument(doc),
  };
  return createMultitrackRecorder(deps);
}

function armTrack(index: number): string {
  const id = useSessionStore.getState().session.tracks[index].id;
  useSessionStore.getState().setTrackParam(id, { armed: true });
  return id;
}

function trackById(id: string) {
  const t = useSessionStore.getState().session.tracks.find((tr) => tr.id === id);
  if (!t) throw new Error(`track ${id} not found`);
  return t;
}

describe('multitrackRecorder', () => {
  beforeEach(() => {
    useAppStore.setState(makeInitialState());
    useSessionStore.getState().newSession(44100);
  });

  afterEach(() => jest.restoreAllMocks());

  it('throws and leaves the engine/player untouched when no track is armed', async () => {
    const engine = fakeEngine({ channels: [new Float32Array(10)], sampleRate: 44100 });
    const player = spyPlayer();
    const rec = makeRecorder(engine, player);

    await expect(rec.start()).rejects.toThrow('No armed tracks');
    expect(player.play).not.toHaveBeenCalled();
    expect(engine.start).not.toHaveBeenCalled();
    expect(rec.isRecording()).toBe(false);
  });

  it('plays from the punch-in cursor and starts the engine when a track is armed', async () => {
    armTrack(0);
    useSessionStore.getState().setMtCursor(500);
    const engine = fakeEngine({ channels: [new Float32Array(10), new Float32Array(10)], sampleRate: 44100 });
    const player = spyPlayer();
    const rec = makeRecorder(engine, player);

    await rec.start();

    expect(player.play).toHaveBeenCalledTimes(1);
    expect(player.play.mock.calls[0][0]).toBe(500);
    expect(player.play.mock.calls[0][1]).toBe(useSessionStore.getState().session);
    expect(engine.start).toHaveBeenCalledWith({ channels: 2, sampleRate: 44100 });
    expect(rec.isRecording()).toBe(true);
  });

  it('creates a Track Recording document and one clip per armed track at the punch-in on stop', async () => {
    const armedA = armTrack(0);
    const armedB = armTrack(2);
    useSessionStore.getState().setMtCursor(1000);
    const engine = fakeEngine({ channels: [new Float32Array(2048), new Float32Array(2048)], sampleRate: 44100 });
    const player = spyPlayer();
    const rec = makeRecorder(engine, player);

    await rec.start();
    await rec.stop();

    expect(player.stop).toHaveBeenCalled();
    const docs = useAppStore.getState().documents;
    expect(docs).toHaveLength(1);
    expect(docs[0].name).toMatch(/^Track Recording \d+$/);
    expect(docs[0].sampleRate).toBe(44100);
    expect(docs[0].channels[0].length).toBe(2048);
    // Task S4: a take exists only in memory until it is saved.
    expect(docs[0].neverSaved).toBe(true);

    for (const id of [armedA, armedB]) {
      const clips = trackById(id).clips;
      expect(clips).toHaveLength(1);
      expect(clips[0]).toMatchObject({
        documentId: docs[0].id,
        startSample: 1000,
        offsetSample: 0,
        lengthSample: 2048,
        gainDb: 0,
      });
    }
    // Non-armed tracks are untouched.
    const tracks = useSessionStore.getState().session.tracks;
    expect(tracks[1].clips).toHaveLength(0);
    expect(tracks[3].clips).toHaveLength(0);
    expect(rec.isRecording()).toBe(false);
  });

  it('records onto exactly the tracks armed at START, ignoring mid-take arm changes', async () => {
    const armedAtStart = armTrack(0);
    const engine = fakeEngine({ channels: [new Float32Array(512), new Float32Array(512)], sampleRate: 44100 });
    const rec = makeRecorder(engine, spyPlayer());

    await rec.start();
    const armedMidTake = armTrack(1); // armed only after recording began
    await rec.stop();

    expect(trackById(armedAtStart).clips).toHaveLength(1);
    expect(trackById(armedMidTake).clips).toHaveLength(0);
  });

  it('resamples each channel when the device rate differs from the session rate', async () => {
    armTrack(0);
    const spy = jest.spyOn(resampleModule, 'resampleChannel');
    const recorded = [new Float32Array(1000), new Float32Array(1000)];
    const engine = fakeEngine({ channels: recorded, sampleRate: 48000 });
    const rec = makeRecorder(engine, spyPlayer());

    await rec.start();
    await rec.stop();

    expect(spy).toHaveBeenCalledTimes(2);
    expect(spy).toHaveBeenCalledWith(recorded[0], 48000, 44100);
    expect(spy).toHaveBeenCalledWith(recorded[1], 48000, 44100);
    expect(useAppStore.getState().documents[0].sampleRate).toBe(44100);
  });

  it('does not resample when the device rate matches the session rate', async () => {
    armTrack(0);
    const spy = jest.spyOn(resampleModule, 'resampleChannel');
    const engine = fakeEngine({ channels: [new Float32Array(256), new Float32Array(256)], sampleRate: 44100 });
    const rec = makeRecorder(engine, spyPlayer());

    await rec.start();
    await rec.stop();

    expect(spy).not.toHaveBeenCalled();
  });

  it('stops the player and propagates the error when the engine fails to start', async () => {
    armTrack(0);
    const engine: RecordingEngineLike = {
      start: jest.fn(async () => {
        throw new Error('mic denied');
      }),
      stop: jest.fn(async () => ({ channels: [], sampleRate: 44100 })),
    };
    const player = spyPlayer();
    const rec = makeRecorder(engine, player);

    await expect(rec.start()).rejects.toThrow('mic denied');
    expect(player.play).toHaveBeenCalled();
    expect(player.stop).toHaveBeenCalled();
    expect(rec.isRecording()).toBe(false);
    expect(useAppStore.getState().documents).toHaveLength(0);
  });

  it('creates no document or clips for an empty take', async () => {
    armTrack(0);
    const engine = fakeEngine({ channels: [new Float32Array(0), new Float32Array(0)], sampleRate: 44100 });
    const rec = makeRecorder(engine, spyPlayer());

    await rec.start();
    await rec.stop();

    expect(useAppStore.getState().documents).toHaveLength(0);
    expect(useSessionStore.getState().session.tracks.every((t) => t.clips.length === 0)).toBe(true);
    expect(rec.isRecording()).toBe(false);
  });

  it('commits the take exactly once when stop() is called twice concurrently', async () => {
    const armed = armTrack(0);
    let resolveStop!: (r: EngineResult) => void;
    const engine: RecordingEngineLike & { start: jest.Mock; stop: jest.Mock } = {
      start: jest.fn(async () => {}),
      stop: jest.fn(
        () =>
          new Promise<EngineResult>((res) => {
            resolveStop = res;
          })
      ),
    };
    const player = spyPlayer();
    const rec = makeRecorder(engine, player);

    await rec.start();
    // Two stop triggers land inside engine.stop()'s async window (double-click
    // Stop, or Stop button + record toggle) — only one may commit.
    const p1 = rec.stop();
    const p2 = rec.stop();
    resolveStop({ channels: [new Float32Array(128), new Float32Array(128)], sampleRate: 44100 });
    await Promise.all([p1, p2]);

    expect(engine.stop).toHaveBeenCalledTimes(1);
    expect(useAppStore.getState().documents).toHaveLength(1);
    expect(trackById(armed).clips).toHaveLength(1);
    expect(rec.isRecording()).toBe(false);
  });

  it('defers a stop() issued during an in-flight start() until the start settles, then commits once', async () => {
    const armed = armTrack(0);
    let resolveStart!: () => void;
    const engine: RecordingEngineLike & { start: jest.Mock; stop: jest.Mock } = {
      start: jest.fn(
        () =>
          new Promise<void>((res) => {
            resolveStart = res;
          })
      ),
      stop: jest.fn(async () => ({
        channels: [new Float32Array(64), new Float32Array(64)],
        sampleRate: 44100,
      })),
    };
    const player = spyPlayer();
    const rec = makeRecorder(engine, player);

    const pStart = rec.start(); // suspended in the permission-prompt window
    const pStop = rec.stop(); // user hits Stop while the prompt is open
    expect(engine.stop).not.toHaveBeenCalled(); // must wait for the start to settle

    resolveStart();
    await Promise.all([pStart, pStop]);

    // The graph was fully built before teardown; no live mic left behind.
    expect(engine.stop).toHaveBeenCalledTimes(1);
    expect(rec.isRecording()).toBe(false);
    expect(useAppStore.getState().documents).toHaveLength(1);
    expect(trackById(armed).clips).toHaveLength(1);
  });

  it('a stop() waiting on a FAILING start() aborts cleanly without touching the engine', async () => {
    armTrack(0);
    let rejectStart!: (e: Error) => void;
    const engine: RecordingEngineLike & { start: jest.Mock; stop: jest.Mock } = {
      start: jest.fn(
        () =>
          new Promise<void>((_res, rej) => {
            rejectStart = rej;
          })
      ),
      stop: jest.fn(async () => ({ channels: [], sampleRate: 44100 })),
    };
    const player = spyPlayer();
    const rec = makeRecorder(engine, player);

    const pStart = rec.start();
    const pStop = rec.stop();
    rejectStart(new Error('mic denied'));

    await expect(pStart).rejects.toThrow('mic denied');
    await pStop; // resolves without committing anything

    expect(engine.stop).not.toHaveBeenCalled(); // nothing was ever recording
    expect(player.stop).toHaveBeenCalled(); // start()'s own monitor rollback
    expect(rec.isRecording()).toBe(false);
    expect(useAppStore.getState().documents).toHaveLength(0);
  });

  it('notifies onChange subscribers as recording starts and stops', async () => {
    armTrack(0);
    const engine = fakeEngine({ channels: [new Float32Array(64), new Float32Array(64)], sampleRate: 44100 });
    const rec = makeRecorder(engine, spyPlayer());
    const states: boolean[] = [];
    const unsub = rec.onChange((r) => states.push(r));

    await rec.start();
    expect(states).toEqual([true]);
    await rec.stop();
    expect(states).toEqual([true, false]);

    unsub();
    await rec.start();
    expect(states).toEqual([true, false]); // no further notifications after unsub
  });
});
