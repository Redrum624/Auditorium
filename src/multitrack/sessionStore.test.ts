import { createClip } from './session';
import { useSessionStore } from './sessionStore';
import { sessionLaneWidth } from './sessionViewport';

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
    // MT1-1: was `{ samplesPerPixel: 512, scrollSample: 0 }`. 512 was a constant
    // with no relationship to anything on screen — 16 s of timeline whatever the
    // session held, which is why a 2:58 session opened showing 18 s of itself. A
    // fresh session is EMPTY, so there is no longest track to fit and the zoom
    // falls to the empty-timeline convention (60 s, per sessionZoom); asserting
    // that relationship rather than the resulting number keeps this test honest
    // if the fallback lane width ever changes.
    expect(state.mtZoom.scrollSample).toBe(0);
    expect(state.mtZoom.samplesPerPixel * sessionLaneWidth()).toBeCloseTo(60 * 48000, 6);
    expect(state.mtPlayState).toBe('stopped');
  });

  it('assigns sequentially increasing relative track ids', () => {
    useSessionStore.getState().newSession(44100);
    const ids = useSessionStore.getState().session.tracks.map((t) => Number(t.id.split('-')[1]));
    for (let i = 1; i < ids.length; i++) {
      expect(ids[i]).toBe(ids[i - 1] + 1);
    }
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

  // The DELIBERATE X5 behaviour change (the v1.8 pin here said exactly this
  // would happen): same-track overlap is first-class on every path now.
  // `addClip` accepts an overlap verbatim and writes no fades; `moveClip`
  // keeps a requested overlap too, with the v1.8 nudge surviving behind
  // opts.clearOverlap (the drag gesture's Ctrl modifier).
  it('accepts a clip overlapping its neighbour — and moveClip keeps a requested overlap (X5)', () => {
    const store = useSessionStore.getState();
    const trackId = store.session.tracks[0].id;
    const sitting = createClip({ documentId: 'doc-1', startSample: 1000, offsetSample: 0, lengthSample: 1000 });
    const overlapping = createClip({ documentId: 'doc-1', startSample: 1500, offsetSample: 0, lengthSample: 1000 });

    store.addClip(trackId, sitting);
    store.addClip(trackId, overlapping);

    const clips = useSessionStore.getState().session.tracks.find((t) => t.id === trackId)!.clips;
    expect(clips).toHaveLength(2);
    expect(clips.map((c) => c.startSample)).toEqual([1000, 1500]); // unmoved: 1500 < 1000+1000
    // addClip never writes fade keys — a programmatic overlap stays raw.
    expect(findClip(sitting.id)!.fadeOutSample).toBeUndefined();
    expect(findClip(overlapping.id)!.fadeInSample).toBeUndefined();

    // The same position requested through moveClip now also commits verbatim —
    // and because this overlap EXISTED before the move and was never armed, it
    // is a raw layering choice the gesture must not overwrite: still no fades.
    useSessionStore.getState().moveClip(overlapping.id, trackId, 1500);
    expect(findClip(overlapping.id)!.startSample).toBe(1500);
    expect(findClip(sitting.id)!.fadeOutSample).toBeUndefined();
    expect(findClip(overlapping.id)!.fadeInSample).toBeUndefined();

    // opts.clearOverlap re-enables the v1.8 forward-only nudge.
    useSessionStore.getState().moveClip(overlapping.id, trackId, 1500, { clearOverlap: true });
    expect(findClip(overlapping.id)!.startSample).toBe(2000);
  });

  it('trimClip may extend a clip over its neighbour — and the NEW overlap arms a crossfade (X5)', () => {
    const store = useSessionStore.getState();
    const trackId = store.session.tracks[0].id;
    const first = createClip({ documentId: 'doc-1', startSample: 0, offsetSample: 0, lengthSample: 1000 });
    const second = createClip({ documentId: 'doc-1', startSample: 1000, offsetSample: 0, lengthSample: 1000 });
    store.addClip(trackId, first);
    store.addClip(trackId, second);

    useSessionStore.getState().trimClip(first.id, 'end', 1800); // 800 samples into `second`

    expect(findClip(first.id)!.lengthSample).toBe(1800);
    expect(findClip(second.id)!.startSample).toBe(1000);
    // The trim PRODUCED this overlap, so the gesture leaves both facing fades
    // spanning it exactly (X3's canonical-pair rule 3) — it renders as a
    // crossfade rather than a raw sum.
    expect(findClip(first.id)!.fadeOutSample).toBe(800);
    expect(findClip(second.id)!.fadeInSample).toBe(800);
    // Away-side edges untouched.
    expect(findClip(first.id)!.fadeInSample).toBeUndefined();
    expect(findClip(second.id)!.fadeOutSample).toBeUndefined();
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

  it('keeps a requested overlapping position and arms the crossfade — overlap is intentional (X5)', () => {
    const store = useSessionStore.getState();
    const trackId = store.session.tracks[0].id;
    const clipA = createClip({ documentId: 'doc-1', startSample: 0, offsetSample: 0, lengthSample: 1000 }); // [0,1000)
    const clipB = createClip({ documentId: 'doc-1', startSample: 5000, offsetSample: 0, lengthSample: 1000 });
    store.addClip(trackId, clipA);
    store.addClip(trackId, clipB);

    store.moveClip(clipB.id, trackId, 500); // requested position overlaps A — deliberately

    expect(findClip(clipB.id)!.startSample).toBe(500); // committed VERBATIM
    // The move CREATED this overlap, so the facing fades span it exactly
    // (X3's canonical pair): A fades out over the overlap, B fades in.
    expect(findClip(clipA.id)!.fadeOutSample).toBe(500); // w = 1000 - 500
    expect(findClip(clipB.id)!.fadeInSample).toBe(500);
    const clips = useSessionStore.getState().session.tracks.find((t) => t.id === trackId)!.clips;
    expect(clips.map((c) => c.id)).toEqual([clipA.id, clipB.id]); // stays sorted
  });

  it('clearOverlap: nudges past every subsequent overlapping clip (the v1.8 nudge, now opt-in)', () => {
    const store = useSessionStore.getState();
    const trackId = store.session.tracks[0].id;
    const clipA = createClip({ documentId: 'doc-1', startSample: 0, offsetSample: 0, lengthSample: 1000 }); // [0,1000)
    const clipC = createClip({ documentId: 'doc-1', startSample: 1000, offsetSample: 0, lengthSample: 1000 }); // [1000,2000)
    const clipB = createClip({ documentId: 'doc-1', startSample: 9000, offsetSample: 0, lengthSample: 1000 });
    store.addClip(trackId, clipA);
    store.addClip(trackId, clipC);
    store.addClip(trackId, clipB);

    store.moveClip(clipB.id, trackId, 500, { clearOverlap: true }); // overlaps A, then the nudged position overlaps C too

    expect(findClip(clipB.id)!.startSample).toBe(2000); // pushed past both A and C
    // The nudged clip overlaps nothing, so the nudge arms nothing.
    expect(findClip(clipB.id)!.fadeInSample).toBeUndefined();
    expect(findClip(clipA.id)!.fadeOutSample).toBeUndefined();
    expect(findClip(clipC.id)!.fadeOutSample).toBeUndefined();
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

// v1.9 X2. setClipFade is THE clamp boundary for clip fades — X4 binds UI
// inputs to it verbatim and re-implements nothing, so these tests pin the
// policy X4 (and X3's envelope indexing) relies on.
describe('setClipFade', () => {
  beforeEach(() => {
    useSessionStore.getState().newSession(44100);
  });

  function seedClip(lengthSample = 1000): string {
    const store = useSessionStore.getState();
    const trackId = store.session.tracks[0].id;
    const clip = createClip({ documentId: 'doc-1', startSample: 0, offsetSample: 0, lengthSample });
    store.addClip(trackId, clip);
    return clip.id;
  }

  it('sets fade-in length and curve on the target clip only', () => {
    const clipId = seedClip();
    const other = createClip({ documentId: 'doc-1', startSample: 5000, offsetSample: 0, lengthSample: 100 });
    useSessionStore.getState().addClip(useSessionStore.getState().session.tracks[0].id, other);

    useSessionStore.getState().setClipFade(clipId, 'in', { lengthSample: 250, curve: 'smooth' });

    const clip = findClip(clipId)!;
    expect(clip.fadeInSample).toBe(250);
    expect(clip.fadeInCurve).toBe('smooth');
    expect(clip.fadeOutSample).toBeUndefined();
    expect(clip.fadeOutCurve).toBeUndefined();
    expect(findClip(other.id)!.fadeInSample).toBeUndefined();
  });

  it('sets fade-out independently of fade-in', () => {
    const clipId = seedClip();
    useSessionStore.getState().setClipFade(clipId, 'in', { lengthSample: 100 });

    useSessionStore.getState().setClipFade(clipId, 'out', { lengthSample: 300, curve: 'exponential' });

    const clip = findClip(clipId)!;
    expect(clip.fadeInSample).toBe(100);
    expect(clip.fadeOutSample).toBe(300);
    expect(clip.fadeOutCurve).toBe('exponential');
    expect(clip.fadeInCurve).toBeUndefined();
  });

  it('rounds a fractional length to the nearest integer', () => {
    const clipId = seedClip();

    useSessionStore.getState().setClipFade(clipId, 'in', { lengthSample: 100.4 });
    expect(findClip(clipId)!.fadeInSample).toBe(100);

    useSessionStore.getState().setClipFade(clipId, 'in', { lengthSample: 100.6 });
    expect(findClip(clipId)!.fadeInSample).toBe(101);
  });

  it('clamps a fade to the clip length', () => {
    const clipId = seedClip(1000);

    useSessionStore.getState().setClipFade(clipId, 'out', { lengthSample: 5000 });

    expect(findClip(clipId)!.fadeOutSample).toBe(1000);
  });

  it('cannot cross the standing opposite fade — the edited fade yields, the standing one is untouched', () => {
    const clipId = seedClip(1000);
    useSessionStore.getState().setClipFade(clipId, 'out', { lengthSample: 600 });

    useSessionStore.getState().setClipFade(clipId, 'in', { lengthSample: 800 }); // only 400 remain

    const clip = findClip(clipId)!;
    expect(clip.fadeInSample).toBe(400);
    expect(clip.fadeOutSample).toBe(600); // standing fade wins
  });

  it('allows the two fades to exactly meet (fadeIn + fadeOut === lengthSample)', () => {
    const clipId = seedClip(1000);
    useSessionStore.getState().setClipFade(clipId, 'out', { lengthSample: 600 });

    useSessionStore.getState().setClipFade(clipId, 'in', { lengthSample: 400 });

    const clip = findClip(clipId)!;
    expect(clip.fadeInSample).toBe(400);
    expect(clip.fadeOutSample).toBe(600);
  });

  it('a negative request clears the fade to "no fade" (undefined, not 0)', () => {
    const clipId = seedClip();
    useSessionStore.getState().setClipFade(clipId, 'in', { lengthSample: 250 });

    useSessionStore.getState().setClipFade(clipId, 'in', { lengthSample: -10 });

    expect(findClip(clipId)!.fadeInSample).toBeUndefined();
  });

  it('a zero request clears the fade but keeps the curve choice', () => {
    const clipId = seedClip();
    useSessionStore.getState().setClipFade(clipId, 'in', { lengthSample: 250, curve: 'smooth' });

    useSessionStore.getState().setClipFade(clipId, 'in', { lengthSample: 0 });

    const clip = findClip(clipId)!;
    expect(clip.fadeInSample).toBeUndefined();
    expect(clip.fadeInCurve).toBe('smooth'); // persists for when the fade returns
  });

  it('ignores a non-finite length request instead of clamping it', () => {
    const clipId = seedClip();
    useSessionStore.getState().setClipFade(clipId, 'in', { lengthSample: 250 });

    useSessionStore.getState().setClipFade(clipId, 'in', { lengthSample: Number.NaN });
    expect(findClip(clipId)!.fadeInSample).toBe(250);

    useSessionStore.getState().setClipFade(clipId, 'in', { lengthSample: Number.POSITIVE_INFINITY });
    expect(findClip(clipId)!.fadeInSample).toBe(250);
  });

  it('rejects an unknown curve at runtime (the type does not protect a JS caller)', () => {
    const clipId = seedClip();

    useSessionStore
      .getState()
      .setClipFade(clipId, 'in', { curve: 'bogus' as unknown as import('../dsp/fades').FadeCurve });

    expect(findClip(clipId)!.fadeInCurve).toBeUndefined();
  });

  it('accepts a curve-only patch on a clip with no fade length', () => {
    const clipId = seedClip();

    useSessionStore.getState().setClipFade(clipId, 'out', { curve: 'equal-gain' });

    const clip = findClip(clipId)!;
    expect(clip.fadeOutCurve).toBe('equal-gain');
    expect(clip.fadeOutSample).toBeUndefined();
  });

  it('is a no-op for an unknown clip id', () => {
    const before = useSessionStore.getState().session;
    useSessionStore.getState().setClipFade('clip-does-not-exist', 'in', { lengthSample: 100 });
    expect(useSessionStore.getState().session).toBe(before);
  });

  it('is a no-op for a patch with nothing valid in it', () => {
    const clipId = seedClip();
    const before = useSessionStore.getState().session;
    useSessionStore.getState().setClipFade(clipId, 'in', {});
    expect(useSessionStore.getState().session).toBe(before);
  });

  // X5 (carried X2 review finding): the "healing" write-back at the bottom of
  // setClipFade's length branch is claimed by its comment but was unpinned —
  // a mutation writing back only the EDITED side survived every store test.
  // An out-of-range standing fade is constructible because addClip performs
  // no validation.
  it('heals an out-of-range STANDING fade when the opposite edge is edited — both sides written back', () => {
    const store = useSessionStore.getState();
    const trackId = store.session.tracks[0].id;
    const clip = {
      ...createClip({ documentId: 'doc-1', startSample: 0, offsetSample: 0, lengthSample: 1000 }),
      fadeOutSample: 1600, // breach: exceeds the clip (addClip skips validation)
    };
    store.addClip(trackId, clip);

    useSessionStore.getState().setClipFade(clip.id, 'in', { lengthSample: 300 });

    const healed = findClip(clip.id)!;
    // The standing breach is clamped to the clip length instead of preserved…
    expect(healed.fadeOutSample).toBe(1000);
    // …and the edited fade gets only the room that remains (none here).
    expect(healed.fadeInSample).toBeUndefined();
  });
});

// v1.9 X2 (trap T17): trimClip rewrites lengthSample via spread, which would
// silently carry fades past the new clip length. Policy under test: the fade
// at the UN-trimmed edge is preserved; the fade at the trimmed edge yields.
describe('trimClip keeps fades coherent', () => {
  beforeEach(() => {
    useSessionStore.getState().newSession(44100);
  });

  function seedFadedClip(opts: {
    startSample: number;
    offsetSample: number;
    lengthSample: number;
    fadeIn?: number;
    fadeOut?: number;
  }): string {
    const store = useSessionStore.getState();
    const trackId = store.session.tracks[0].id;
    const clip = createClip({
      documentId: 'doc-1',
      startSample: opts.startSample,
      offsetSample: opts.offsetSample,
      lengthSample: opts.lengthSample,
    });
    store.addClip(trackId, clip);
    if (opts.fadeIn) store.setClipFade(clip.id, 'in', { lengthSample: opts.fadeIn });
    if (opts.fadeOut) store.setClipFade(clip.id, 'out', { lengthSample: opts.fadeOut });
    return clip.id;
  }

  it('end trim under the fades: fade-in preserved, fade-out yields the difference', () => {
    const clipId = seedFadedClip({ startSample: 0, offsetSample: 0, lengthSample: 1000, fadeIn: 300, fadeOut: 300 });

    useSessionStore.getState().trimClip(clipId, 'end', 400); // new length 400 < 300+300

    const clip = findClip(clipId)!;
    expect(clip.lengthSample).toBe(400);
    expect(clip.fadeInSample).toBe(300);
    expect(clip.fadeOutSample).toBe(100);
  });

  it('end trim past the fade-in: fade-in clamps to the clip, fade-out is squeezed out entirely (undefined)', () => {
    const clipId = seedFadedClip({ startSample: 0, offsetSample: 0, lengthSample: 1000, fadeIn: 300, fadeOut: 300 });

    useSessionStore.getState().trimClip(clipId, 'end', 100); // new length 100 < fadeIn alone

    const clip = findClip(clipId)!;
    expect(clip.lengthSample).toBe(100);
    expect(clip.fadeInSample).toBe(100);
    expect(clip.fadeOutSample).toBeUndefined();
  });

  it('start trim under the fades: fade-out preserved, fade-in yields (mirror of the end trim)', () => {
    const clipId = seedFadedClip({ startSample: 0, offsetSample: 0, lengthSample: 1000, fadeIn: 300, fadeOut: 300 });

    useSessionStore.getState().trimClip(clipId, 'start', 600); // new length 400

    const clip = findClip(clipId)!;
    expect(clip.lengthSample).toBe(400);
    expect(clip.fadeOutSample).toBe(300);
    expect(clip.fadeInSample).toBe(100);
  });

  it('a trim that still leaves room for both fades touches neither', () => {
    const clipId = seedFadedClip({ startSample: 0, offsetSample: 0, lengthSample: 1000, fadeIn: 200, fadeOut: 200 });

    useSessionStore.getState().trimClip(clipId, 'end', 400); // 200+200 === 400 exactly — legal

    const clip = findClip(clipId)!;
    expect(clip.fadeInSample).toBe(200);
    expect(clip.fadeOutSample).toBe(200);
  });

  it('a trim that LENGTHENS the clip leaves fades untouched', () => {
    const clipId = seedFadedClip({ startSample: 0, offsetSample: 0, lengthSample: 1000, fadeIn: 300, fadeOut: 300 });

    useSessionStore.getState().trimClip(clipId, 'end', 5000);

    const clip = findClip(clipId)!;
    expect(clip.fadeInSample).toBe(300);
    expect(clip.fadeOutSample).toBe(300);
  });

  it('a fade-free clip trims without gaining fade keys', () => {
    const clipId = seedFadedClip({ startSample: 0, offsetSample: 0, lengthSample: 1000 });

    useSessionStore.getState().trimClip(clipId, 'end', 400);

    const clip = findClip(clipId)!;
    expect(clip.fadeInSample).toBeUndefined();
    expect(clip.fadeOutSample).toBeUndefined();
  });

  it('moveClip carries fades over unchanged (spread regression guard)', () => {
    const clipId = seedFadedClip({ startSample: 0, offsetSample: 0, lengthSample: 1000, fadeIn: 250, fadeOut: 100 });
    const trackB = useSessionStore.getState().session.tracks[1].id;

    useSessionStore.getState().moveClip(clipId, trackB, 2000);

    const clip = findClip(clipId)!;
    expect(clip.startSample).toBe(2000);
    expect(clip.fadeInSample).toBe(250);
    expect(clip.fadeOutSample).toBe(100);
  });
});
