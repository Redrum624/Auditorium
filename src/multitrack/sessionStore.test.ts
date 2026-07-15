import { createClip } from './session';
import { useSessionStore } from './sessionStore';
import * as clipWaveformCache from '../components/Multitrack/clipWaveformCache';

function findClip(clipId: string) {
  for (const track of useSessionStore.getState().session.tracks) {
    const clip = track.clips.find((c) => c.id === clipId);
    if (clip) return clip;
  }
  return undefined;
}

// The very first test exercises a freshly-loaded module, so its track ids are
// literally 'track-1'..'track-4'. Every later test only asserts the ids are
// sequential relative to each other (the nextId counter is never reset
// between tests, so absolute numbers keep climbing across the file).
describe('newSession', () => {
  it('creates "Untitled Session" with 4 empty tracks named Track 1..4 and default UI state', () => {
    useSessionStore.getState().newSession(48000);
    const state = useSessionStore.getState();

    expect(state.session.name).toBe('Untitled Session');
    expect(state.session.sampleRate).toBe(48000);
    expect(state.session.tracks).toHaveLength(4);
    expect(state.session.tracks.map((t) => t.name)).toEqual(['Track 1', 'Track 2', 'Track 3', 'Track 4']);
    for (const track of state.session.tracks) {
      expect(track.volumeDb).toBe(0);
      expect(track.pan).toBe(0);
      expect(track.muted).toBe(false);
      expect(track.solo).toBe(false);
      expect(track.armed).toBe(false);
      expect(track.clips).toEqual([]);
    }

    expect(state.selectedClipId).toBeNull();
    expect(state.mtCursorSample).toBe(0);
    expect(state.mtZoom).toEqual({ samplesPerPixel: 512, scrollSample: 0 });
    expect(state.mtPlayState).toBe('stopped');
  });

  it('assigns sequentially increasing relative track ids', () => {
    useSessionStore.getState().newSession(44100);
    const ids = useSessionStore.getState().session.tracks.map((t) => Number(t.id.split('-')[1]));
    for (let i = 1; i < ids.length; i++) {
      expect(ids[i]).toBe(ids[i - 1] + 1);
    }
  });

  it('clears the mini-waveform cache (F9) — a fresh session invalidates every clip bitmap', () => {
    clipWaveformCache._resetClipWaveformCache();
    clipWaveformCache.getClipWaveformCanvas(
      { clipId: 'clip-stale', lengthSample: 100, bucket: 0, height: 40, offsetSample: 0, channels: [] },
      10,
      () => {}
    );
    expect(clipWaveformCache._clipWaveformCacheSize()).toBe(1);

    useSessionStore.getState().newSession(44100);

    expect(clipWaveformCache._clipWaveformCacheSize()).toBe(0);
  });
});

describe('addTrack / removeTrack / renameTrack', () => {
  beforeEach(() => {
    useSessionStore.getState().newSession(44100);
  });

  it('addTrack appends a track named by position', () => {
    useSessionStore.getState().addTrack();
    const tracks = useSessionStore.getState().session.tracks;
    expect(tracks).toHaveLength(5);
    expect(tracks[4].name).toBe('Track 5');
  });

  it('removeTrack removes the track and leaves the others intact', () => {
    const store = useSessionStore.getState();
    const targetId = store.session.tracks[1].id;
    store.removeTrack(targetId);
    const tracks = useSessionStore.getState().session.tracks;
    expect(tracks).toHaveLength(3);
    expect(tracks.some((t) => t.id === targetId)).toBe(false);
  });

  it('removeTrack clears selectedClipId when it pointed into the removed track', () => {
    const store = useSessionStore.getState();
    const trackId = store.session.tracks[0].id;
    const clip = createClip({ documentId: 'doc-1', startSample: 0, offsetSample: 0, lengthSample: 100 });
    store.addClip(trackId, clip);
    store.setSelectedClip(clip.id);

    store.removeTrack(trackId);

    expect(useSessionStore.getState().selectedClipId).toBeNull();
  });

  it('removeTrack leaves selectedClipId untouched when it points into a different track', () => {
    const store = useSessionStore.getState();
    const trackA = store.session.tracks[0].id;
    const trackB = store.session.tracks[1].id;
    const clip = createClip({ documentId: 'doc-1', startSample: 0, offsetSample: 0, lengthSample: 100 });
    store.addClip(trackB, clip);
    store.setSelectedClip(clip.id);

    store.removeTrack(trackA);

    expect(useSessionStore.getState().selectedClipId).toBe(clip.id);
  });

  it('removeTrack purges every removed clip from the mini-waveform cache (F9)', () => {
    const store = useSessionStore.getState();
    const trackId = store.session.tracks[0].id;
    const clipA = createClip({ documentId: 'doc-1', startSample: 0, offsetSample: 0, lengthSample: 100 });
    const clipB = createClip({ documentId: 'doc-1', startSample: 500, offsetSample: 0, lengthSample: 100 });
    store.addClip(trackId, clipA);
    store.addClip(trackId, clipB);
    clipWaveformCache._resetClipWaveformCache();
    clipWaveformCache.getClipWaveformCanvas(
      { clipId: clipA.id, lengthSample: 100, bucket: 0, height: 40, offsetSample: 0, channels: [] },
      10,
      () => {}
    );
    clipWaveformCache.getClipWaveformCanvas(
      { clipId: clipB.id, lengthSample: 100, bucket: 0, height: 40, offsetSample: 0, channels: [] },
      10,
      () => {}
    );
    expect(clipWaveformCache._clipWaveformCacheSize()).toBe(2);

    store.removeTrack(trackId);

    expect(clipWaveformCache._clipWaveformCacheSize()).toBe(0);
  });

  it('renameTrack preserves the full name without truncation', () => {
    const store = useSessionStore.getState();
    const trackId = store.session.tracks[0].id;
    const longName = 'x'.repeat(80);
    store.renameTrack(trackId, longName);
    const track = useSessionStore.getState().session.tracks.find((t) => t.id === trackId)!;
    expect(track.name).toBe(longName);
    expect(track.name).toHaveLength(80);
  });
});

describe('setTrackParam', () => {
  beforeEach(() => {
    useSessionStore.getState().newSession(44100);
  });

  it('updates muted/solo/armed/volumeDb/pan independently without touching the rest', () => {
    const store = useSessionStore.getState();
    const trackId = store.session.tracks[0].id;

    store.setTrackParam(trackId, { muted: true });
    store.setTrackParam(trackId, { solo: true, volumeDb: -6, pan: 0.5 });

    const track = useSessionStore.getState().session.tracks.find((t) => t.id === trackId)!;
    expect(track.muted).toBe(true);
    expect(track.solo).toBe(true);
    expect(track.volumeDb).toBe(-6);
    expect(track.pan).toBe(0.5);
    expect(track.armed).toBe(false);
  });

  it('does not affect other tracks', () => {
    const store = useSessionStore.getState();
    const [trackA, trackB] = store.session.tracks;
    store.setTrackParam(trackA.id, { muted: true });
    const after = useSessionStore.getState().session.tracks.find((t) => t.id === trackB.id)!;
    expect(after.muted).toBe(false);
  });
});

describe('addClip', () => {
  beforeEach(() => {
    useSessionStore.getState().newSession(44100);
  });

  it('inserts clips sorted by startSample regardless of insertion order', () => {
    const store = useSessionStore.getState();
    const trackId = store.session.tracks[0].id;
    const late = createClip({ documentId: 'doc-1', startSample: 2000, offsetSample: 0, lengthSample: 100 });
    const early = createClip({ documentId: 'doc-1', startSample: 0, offsetSample: 0, lengthSample: 100 });
    const mid = createClip({ documentId: 'doc-1', startSample: 1000, offsetSample: 0, lengthSample: 100 });

    store.addClip(trackId, late);
    store.addClip(trackId, early);
    store.addClip(trackId, mid);

    const clips = useSessionStore.getState().session.tracks.find((t) => t.id === trackId)!.clips;
    expect(clips.map((c) => c.id)).toEqual([early.id, mid.id, late.id]);
  });
});

describe('moveClip', () => {
  beforeEach(() => {
    useSessionStore.getState().newSession(44100);
  });

  it('clamps the requested start to >= 0', () => {
    const store = useSessionStore.getState();
    const trackId = store.session.tracks[0].id;
    const clip = createClip({ documentId: 'doc-1', startSample: 500, offsetSample: 0, lengthSample: 100 });
    store.addClip(trackId, clip);

    store.moveClip(clip.id, trackId, -50);

    expect(findClip(clip.id)!.startSample).toBe(0);
  });

  it('nudges to the nearest free gap (clip end) when the requested position overlaps an existing clip', () => {
    const store = useSessionStore.getState();
    const trackId = store.session.tracks[0].id;
    const clipA = createClip({ documentId: 'doc-1', startSample: 0, offsetSample: 0, lengthSample: 1000 }); // [0,1000)
    const clipB = createClip({ documentId: 'doc-1', startSample: 5000, offsetSample: 0, lengthSample: 1000 });
    store.addClip(trackId, clipA);
    store.addClip(trackId, clipB);

    store.moveClip(clipB.id, trackId, 500); // requested position overlaps A

    expect(findClip(clipB.id)!.startSample).toBe(1000); // A's end
    const clips = useSessionStore.getState().session.tracks.find((t) => t.id === trackId)!.clips;
    expect(clips.map((c) => c.id)).toEqual([clipA.id, clipB.id]); // stays sorted
  });

  it('resolves a multi-clip chain by nudging past every subsequent overlapping clip', () => {
    const store = useSessionStore.getState();
    const trackId = store.session.tracks[0].id;
    const clipA = createClip({ documentId: 'doc-1', startSample: 0, offsetSample: 0, lengthSample: 1000 }); // [0,1000)
    const clipC = createClip({ documentId: 'doc-1', startSample: 1000, offsetSample: 0, lengthSample: 1000 }); // [1000,2000)
    const clipB = createClip({ documentId: 'doc-1', startSample: 9000, offsetSample: 0, lengthSample: 1000 });
    store.addClip(trackId, clipA);
    store.addClip(trackId, clipC);
    store.addClip(trackId, clipB);

    store.moveClip(clipB.id, trackId, 500); // overlaps A, then the nudged position overlaps C too

    expect(findClip(clipB.id)!.startSample).toBe(2000); // pushed past both A and C
  });

  it('does not nudge when the requested position is already free', () => {
    const store = useSessionStore.getState();
    const trackId = store.session.tracks[0].id;
    const clipA = createClip({ documentId: 'doc-1', startSample: 0, offsetSample: 0, lengthSample: 1000 });
    const clipB = createClip({ documentId: 'doc-1', startSample: 5000, offsetSample: 0, lengthSample: 1000 });
    store.addClip(trackId, clipA);
    store.addClip(trackId, clipB);

    store.moveClip(clipB.id, trackId, 2000); // free gap after A, no overlap

    expect(findClip(clipB.id)!.startSample).toBe(2000);
  });

  it('moves a clip to a different track and removes it from the source track', () => {
    const store = useSessionStore.getState();
    const [trackA, trackB] = store.session.tracks;
    const clip = createClip({ documentId: 'doc-1', startSample: 0, offsetSample: 0, lengthSample: 100 });
    store.addClip(trackA.id, clip);

    store.moveClip(clip.id, trackB.id, 200);

    const state = useSessionStore.getState();
    expect(state.session.tracks.find((t) => t.id === trackA.id)!.clips).toHaveLength(0);
    const moved = state.session.tracks.find((t) => t.id === trackB.id)!.clips[0];
    expect(moved.id).toBe(clip.id);
    expect(moved.startSample).toBe(200);
  });

  it('is a no-op for an unknown clip id', () => {
    const store = useSessionStore.getState();
    const trackId = store.session.tracks[0].id;
    const before = useSessionStore.getState().session;
    store.moveClip('clip-does-not-exist', trackId, 0);
    expect(useSessionStore.getState().session).toBe(before);
  });
});

describe('trimClip', () => {
  beforeEach(() => {
    useSessionStore.getState().newSession(44100);
  });

  function seedClip(opts: { startSample: number; offsetSample: number; lengthSample: number }) {
    const store = useSessionStore.getState();
    const trackId = store.session.tracks[0].id;
    const clip = createClip({ documentId: 'doc-1', ...opts });
    store.addClip(trackId, clip);
    return clip.id;
  }

  it('start edge: moving the start earlier shrinks offsetSample and grows lengthSample together', () => {
    const clipId = seedClip({ startSample: 1000, offsetSample: 500, lengthSample: 2000 }); // end=3000

    useSessionStore.getState().trimClip(clipId, 'start', 1200);

    const clip = findClip(clipId)!;
    expect(clip.startSample).toBe(1200);
    expect(clip.offsetSample).toBe(700); // 500 + (1200-1000)
    expect(clip.lengthSample).toBe(1800); // 3000-1200
  });

  it('start edge: is limited earlier by offsetSample >= 0', () => {
    const clipId = seedClip({ startSample: 1000, offsetSample: 500, lengthSample: 2000 }); // end=3000

    useSessionStore.getState().trimClip(clipId, 'start', 0); // request far earlier than offset allows

    const clip = findClip(clipId)!;
    expect(clip.startSample).toBe(500); // 1000 - 500 (earliest offset can reach is 0)
    expect(clip.offsetSample).toBe(0);
    expect(clip.lengthSample).toBe(2500); // 3000-500
  });

  it('start edge: is limited later by min length 32', () => {
    const clipId = seedClip({ startSample: 1000, offsetSample: 500, lengthSample: 2000 }); // end=3000

    useSessionStore.getState().trimClip(clipId, 'start', 10000); // request far past the end

    const clip = findClip(clipId)!;
    expect(clip.lengthSample).toBe(32);
    expect(clip.startSample).toBe(3000 - 32);
    expect(clip.offsetSample).toBe(500 + (clip.startSample - 1000));
  });

  it('end edge: adjusts lengthSample, leaving startSample/offsetSample untouched', () => {
    const clipId = seedClip({ startSample: 1000, offsetSample: 300, lengthSample: 2000 });

    useSessionStore.getState().trimClip(clipId, 'end', 2500); // new end at 2500

    const clip = findClip(clipId)!;
    expect(clip.startSample).toBe(1000);
    expect(clip.offsetSample).toBe(300);
    expect(clip.lengthSample).toBe(1500); // 2500-1000
  });

  it('end edge: is limited by min length 32', () => {
    const clipId = seedClip({ startSample: 1000, offsetSample: 0, lengthSample: 2000 });

    useSessionStore.getState().trimClip(clipId, 'end', 1010); // request far below start+32

    const clip = findClip(clipId)!;
    expect(clip.lengthSample).toBe(32);
  });

  it('end edge: does NOT enforce a source-length upper bound (left to the UI)', () => {
    const clipId = seedClip({ startSample: 1000, offsetSample: 0, lengthSample: 2000 });

    useSessionStore.getState().trimClip(clipId, 'end', 1000000); // arbitrarily far past any real source length

    const clip = findClip(clipId)!;
    expect(clip.lengthSample).toBe(999000); // unclamped: 1000000-1000
  });
});

describe('removeClip', () => {
  beforeEach(() => {
    useSessionStore.getState().newSession(44100);
  });

  it('removes the clip from its track', () => {
    const store = useSessionStore.getState();
    const trackId = store.session.tracks[0].id;
    const clip = createClip({ documentId: 'doc-1', startSample: 0, offsetSample: 0, lengthSample: 100 });
    store.addClip(trackId, clip);

    store.removeClip(clip.id);

    expect(useSessionStore.getState().session.tracks.find((t) => t.id === trackId)!.clips).toHaveLength(0);
  });

  it('clears selectedClipId when the removed clip was selected', () => {
    const store = useSessionStore.getState();
    const trackId = store.session.tracks[0].id;
    const clip = createClip({ documentId: 'doc-1', startSample: 0, offsetSample: 0, lengthSample: 100 });
    store.addClip(trackId, clip);
    store.setSelectedClip(clip.id);

    store.removeClip(clip.id);

    expect(useSessionStore.getState().selectedClipId).toBeNull();
  });

  it('purges the removed clip from the mini-waveform cache (Task F9)', () => {
    const store = useSessionStore.getState();
    const trackId = store.session.tracks[0].id;
    const clip = createClip({ documentId: 'doc-1', startSample: 0, offsetSample: 0, lengthSample: 100 });
    store.addClip(trackId, clip);
    const purgeSpy = jest.spyOn(clipWaveformCache, 'purgeClip');

    store.removeClip(clip.id);

    expect(purgeSpy).toHaveBeenCalledWith(clip.id);
  });
});

describe('setSelectedClip / setMtCursor / setMtZoom', () => {
  beforeEach(() => {
    useSessionStore.getState().newSession(44100);
  });

  it('setSelectedClip / setMtCursor / setMtZoom update state directly', () => {
    const store = useSessionStore.getState();
    store.setSelectedClip('clip-42');
    store.setMtCursor(12345);
    store.setMtZoom({ samplesPerPixel: 256, scrollSample: 999 });

    const state = useSessionStore.getState();
    expect(state.selectedClipId).toBe('clip-42');
    expect(state.mtCursorSample).toBe(12345);
    expect(state.mtZoom).toEqual({ samplesPerPixel: 256, scrollSample: 999 });
  });
});

describe('setClipGain', () => {
  beforeEach(() => {
    useSessionStore.getState().newSession(44100);
  });

  function seedClip(): string {
    const store = useSessionStore.getState();
    const trackId = store.session.tracks[0].id;
    const clip = createClip({ documentId: 'doc-1', startSample: 0, offsetSample: 0, lengthSample: 100 });
    store.addClip(trackId, clip);
    return clip.id;
  }

  it('updates the gainDb of the target clip only', () => {
    const clipId = seedClip();
    const other = createClip({ documentId: 'doc-1', startSample: 500, offsetSample: 0, lengthSample: 50 });
    useSessionStore.getState().addClip(useSessionStore.getState().session.tracks[0].id, other);

    useSessionStore.getState().setClipGain(clipId, 6);

    expect(findClip(clipId)!.gainDb).toBe(6);
    expect(findClip(other.id)!.gainDb).toBe(0);
  });

  it('clamps to the -24..+24 range', () => {
    const clipId = seedClip();

    useSessionStore.getState().setClipGain(clipId, 100);
    expect(findClip(clipId)!.gainDb).toBe(24);

    useSessionStore.getState().setClipGain(clipId, -100);
    expect(findClip(clipId)!.gainDb).toBe(-24);
  });

  it('is a no-op for an unknown clip id', () => {
    const before = useSessionStore.getState().session;
    useSessionStore.getState().setClipGain('clip-does-not-exist', 5);
    expect(useSessionStore.getState().session).toBe(before);
  });
});
