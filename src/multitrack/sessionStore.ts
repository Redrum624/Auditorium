import { create } from 'zustand';
import type { Clip, Session, Track } from './session';
import { createTrack } from './session';

export interface SessionState {
  session: Session;
  selectedClipId: string | null;
  mtCursorSample: number;
  mtZoom: { samplesPerPixel: number; scrollSample: number };
  mtPlayState: 'stopped' | 'playing';
}

export interface SessionActions {
  newSession(sampleRate: number): void; // 'Untitled Session', 4 empty tracks 'Track 1'..'Track 4'
  addTrack(): void;
  removeTrack(id: string): void;
  renameTrack(id: string, name: string): void;
  setTrackParam(
    id: string,
    patch: Partial<Pick<Track, 'volumeDb' | 'pan' | 'muted' | 'solo' | 'armed'>>
  ): void;
  addClip(trackId: string, clip: Clip): void; // inserts sorted; caller guarantees no overlap (UI enforces)
  moveClip(clipId: string, toTrackId: string, newStartSample: number): void; // clamps >=0; nudges to nearest free gap
  trimClip(clipId: string, edge: 'start' | 'end', newBoundarySample: number): void; // adjusts offset/length, min 32
  removeClip(clipId: string): void;
  setSelectedClip(id: string | null): void;
  setMtCursor(s: number): void;
  setMtZoom(z: SessionState['mtZoom']): void;
}

function defaultMtZoom(): SessionState['mtZoom'] {
  return { samplesPerPixel: 512, scrollSample: 0 };
}

function makeSession(sampleRate: number): Session {
  return {
    name: 'Untitled Session',
    sampleRate,
    tracks: [createTrack('Track 1'), createTrack('Track 2'), createTrack('Track 3'), createTrack('Track 4')],
  };
}

/** Inserts `clip` into a copy of `clips`, keeping the result sorted ascending
 * by startSample. Does not mutate the input array. */
function insertSorted(clips: Clip[], clip: Clip): Clip[] {
  const next = [...clips];
  const idx = next.findIndex((c) => c.startSample > clip.startSample);
  if (idx === -1) next.push(clip);
  else next.splice(idx, 0, clip);
  return next;
}

/** Resolves an overlap by nudging `requestedStart` forward to the nearest
 * position where a clip of `length` samples does not overlap any clip in
 * `clips` (which must be sorted ascending by startSample and already
 * non-overlapping among themselves — i.e. the moving clip removed).
 *
 * A single forward pass suffices: whenever the candidate is nudged past
 * clip[i]'s end, clip[i+1] cannot start earlier than that (the track's clips
 * are non-overlapping), so later clips can only push the candidate further
 * forward, never require re-checking an earlier clip. */
function resolveOverlap(clips: Clip[], length: number, requestedStart: number): number {
  let candidate = Math.max(0, requestedStart);
  for (const c of clips) {
    const clipEnd = c.startSample + c.lengthSample;
    const candidateEnd = candidate + length;
    const overlaps = candidate < clipEnd && candidateEnd > c.startSample;
    if (overlaps) candidate = clipEnd;
  }
  return candidate;
}

function findClipLocation(
  tracks: Track[],
  clipId: string
): { trackIdx: number; clipIdx: number } | null {
  for (let trackIdx = 0; trackIdx < tracks.length; trackIdx++) {
    const clipIdx = tracks[trackIdx].clips.findIndex((c) => c.id === clipId);
    if (clipIdx !== -1) return { trackIdx, clipIdx };
  }
  return null;
}

export const useSessionStore = create<SessionState & SessionActions>()((set) => ({
  session: makeSession(44100),
  selectedClipId: null,
  mtCursorSample: 0,
  mtZoom: defaultMtZoom(),
  mtPlayState: 'stopped',

  newSession(sampleRate) {
    set({
      session: makeSession(sampleRate),
      selectedClipId: null,
      mtCursorSample: 0,
      mtZoom: defaultMtZoom(),
      mtPlayState: 'stopped',
    });
  },

  addTrack() {
    set((s) => {
      const name = `Track ${s.session.tracks.length + 1}`;
      return { session: { ...s.session, tracks: [...s.session.tracks, createTrack(name)] } };
    });
  },

  removeTrack(id) {
    set((s) => {
      const removed = s.session.tracks.find((t) => t.id === id);
      if (!removed) return s;
      const tracks = s.session.tracks.filter((t) => t.id !== id);
      const selectedClipId =
        s.selectedClipId !== null && removed.clips.some((c) => c.id === s.selectedClipId)
          ? null
          : s.selectedClipId;
      return { session: { ...s.session, tracks }, selectedClipId };
    });
  },

  renameTrack(id, name) {
    const trimmed = name.slice(0, 60);
    set((s) => ({
      session: {
        ...s.session,
        tracks: s.session.tracks.map((t) => (t.id === id ? { ...t, name: trimmed } : t)),
      },
    }));
  },

  setTrackParam(id, patch) {
    set((s) => ({
      session: {
        ...s.session,
        tracks: s.session.tracks.map((t) => (t.id === id ? { ...t, ...patch } : t)),
      },
    }));
  },

  addClip(trackId, clip) {
    set((s) => ({
      session: {
        ...s.session,
        tracks: s.session.tracks.map((t) =>
          t.id === trackId ? { ...t, clips: insertSorted(t.clips, clip) } : t
        ),
      },
    }));
  },

  moveClip(clipId, toTrackId, newStartSample) {
    set((s) => {
      const loc = findClipLocation(s.session.tracks, clipId);
      const targetTrackIdx = s.session.tracks.findIndex((t) => t.id === toTrackId);
      if (!loc || targetTrackIdx === -1) return s;

      const clip = s.session.tracks[loc.trackIdx].clips[loc.clipIdx];
      const tracks = s.session.tracks.map((t) => ({ ...t, clips: [...t.clips] }));
      tracks[loc.trackIdx].clips.splice(loc.clipIdx, 1);

      const requestedStart = Math.max(0, newStartSample);
      const resolvedStart = resolveOverlap(tracks[targetTrackIdx].clips, clip.lengthSample, requestedStart);
      const movedClip: Clip = { ...clip, startSample: resolvedStart };
      tracks[targetTrackIdx].clips = insertSorted(tracks[targetTrackIdx].clips, movedClip);

      return { session: { ...s.session, tracks } };
    });
  },

  trimClip(clipId, edge, newBoundarySample) {
    set((s) => {
      const loc = findClipLocation(s.session.tracks, clipId);
      if (!loc) return s;
      const clip = s.session.tracks[loc.trackIdx].clips[loc.clipIdx];

      let updated: Clip;
      if (edge === 'start') {
        const end = clip.startSample + clip.lengthSample;
        const earliest = clip.startSample - clip.offsetSample; // offsetSample can't go below 0
        const latest = end - 32; // lengthSample can't go below 32
        const newStart = Math.min(Math.max(newBoundarySample, earliest), latest);
        updated = {
          ...clip,
          startSample: newStart,
          offsetSample: clip.offsetSample + (newStart - clip.startSample),
          lengthSample: end - newStart,
        };
      } else {
        // The upper bound (offsetSample + newLength <= source document length)
        // is intentionally NOT enforced here: the store has no reference to
        // the source AudioDocument, only its id, so it cannot know the
        // document's length. The multitrack UI (Task 22) is responsible for
        // clamping newBoundarySample to the source's available length before
        // calling trimClip; this store only guarantees the min-length-32
        // invariant, which is data it always has.
        const minEnd = clip.startSample + 32;
        const newEnd = Math.max(newBoundarySample, minEnd);
        updated = { ...clip, lengthSample: newEnd - clip.startSample };
      }

      const tracks = s.session.tracks.map((t, i) =>
        i === loc.trackIdx ? { ...t, clips: t.clips.map((c, j) => (j === loc.clipIdx ? updated : c)) } : t
      );
      return { session: { ...s.session, tracks } };
    });
  },

  removeClip(clipId) {
    set((s) => {
      const loc = findClipLocation(s.session.tracks, clipId);
      if (!loc) return s;
      const tracks = s.session.tracks.map((t, i) =>
        i === loc.trackIdx ? { ...t, clips: t.clips.filter((c) => c.id !== clipId) } : t
      );
      const selectedClipId = s.selectedClipId === clipId ? null : s.selectedClipId;
      return { session: { ...s.session, tracks }, selectedClipId };
    });
  },

  setSelectedClip(id) {
    set({ selectedClipId: id });
  },

  setMtCursor(sample) {
    set({ mtCursorSample: sample });
  },

  setMtZoom(z) {
    set({ mtZoom: z });
  },
}));
