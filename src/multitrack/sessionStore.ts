import { create } from 'zustand';
import type { Clip, Session, Track } from './session';
import { createTrack } from './session';
import {
  purgeClip as purgeClipWaveform,
  clearClipWaveformCache,
} from '../components/Multitrack/clipWaveformCache';

export interface SessionState {
  session: Session;
  selectedClipId: string | null;
  mtCursorSample: number;
  mtZoom: { samplesPerPixel: number; scrollSample: number };
  mtPlayState: 'stopped' | 'playing';
  /**
   * Live playhead position (session samples) pushed by the transport pump while
   * multitrack playback runs — the read-model the lanes render their playhead
   * line from. Additive extension over the Task 21 contract (Task 22).
   */
  mtPlayheadSample: number;
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
  /** OVERLAP CONTRACT — what actually happens, replacing an earlier comment
   * here that claimed "caller guarantees no overlap (UI enforces)". Nothing
   * enforces that:
   *  - `addClip` inserts sorted and ACCEPTS a clip overlapping its neighbour.
   *    Insert Active File (`menuActions.ts`'s `insertActiveDocAsClip`) drops
   *    the clip at the cursor, and punch-in recording (`multitrackRecord.ts`)
   *    at the punch-in sample, neither checking what is already there.
   *  - `trimClip` can likewise extend a clip over its neighbour.
   *  - `moveClip` alone nudges clear, via `resolveOverlap` — its only caller.
   * An overlap that reaches the audio path is mixed as an unshaped RAW SUM,
   * hard-clamped to +/-1 afterwards (`mixdown.ts`), so it can clip.
   *
   * This inconsistency is recorded, not endorsed: v1.8 task X5 makes same-track
   * overlap first-class and crossfaded, unifying all three paths. The tests in
   * `sessionStore.test.ts` pin today's behaviour so that change reads as
   * deliberate rather than accidental. */
  addClip(trackId: string, clip: Clip): void; // inserts sorted; an overlapping clip is accepted
  moveClip(clipId: string, toTrackId: string, newStartSample: number): void; // clamps >=0; nudges to nearest free gap
  trimClip(clipId: string, edge: 'start' | 'end', newBoundarySample: number): void; // adjusts offset/length, min 32; may overlap a neighbour
  removeClip(clipId: string): void;
  /** Sets a clip's gain trim in dB, clamped to [-24, 24]. No-op for an unknown
   * clip id. Additive (Task 23): wired to the PropertiesPanel's clip gain input. */
  setClipGain(clipId: string, gainDb: number): void;
  setSelectedClip(id: string | null): void;
  setMtCursor(s: number): void;
  setMtZoom(z: SessionState['mtZoom']): void;
  setMtPlayState(state: SessionState['mtPlayState']): void;
  setMtPlayheadSample(s: number): void;
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
 * `clips` (sorted ascending by startSample, with the moving clip removed).
 * `moveClip` is its ONLY caller — see the overlap contract on `addClip` for
 * the paths that create overlaps instead of resolving them.
 *
 * A single forward pass suffices, and does so even when `clips` themselves
 * overlap (they can): `candidate` only ever moves forward, to the end of a
 * clip it was found to overlap, and every clip is tested against the candidate
 * position current at the time — a clip ending before the candidate cannot
 * overlap it, and one ending after pushes it further forward. So on exit the
 * candidate clears all of them, with no need to re-check an earlier clip. */
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
  mtPlayheadSample: 0,

  newSession(sampleRate) {
    set({
      session: makeSession(sampleRate),
      selectedClipId: null,
      mtCursorSample: 0,
      mtZoom: defaultMtZoom(),
      mtPlayState: 'stopped',
      mtPlayheadSample: 0,
    });
    // A fresh session discards every track/clip that could own a cached
    // mini-waveform bitmap (F9) — clear the whole cache rather than track
    // which entries belonged to the discarded session.
    clearClipWaveformCache();
  },

  addTrack() {
    set((s) => {
      const name = `Track ${s.session.tracks.length + 1}`;
      return { session: { ...s.session, tracks: [...s.session.tracks, createTrack(name)] } };
    });
  },

  removeTrack(id) {
    // Captured inside the set() updater below so the post-set purge (F9) knows
    // exactly which clips died with the track, without a second state lookup.
    let removedClipIds: string[] = [];
    set((s) => {
      const removed = s.session.tracks.find((t) => t.id === id);
      if (!removed) return s;
      removedClipIds = removed.clips.map((c) => c.id);
      const tracks = s.session.tracks.filter((t) => t.id !== id);
      const selectedClipId =
        s.selectedClipId !== null && removed.clips.some((c) => c.id === s.selectedClipId)
          ? null
          : s.selectedClipId;
      return { session: { ...s.session, tracks }, selectedClipId };
    });
    // Each removed clip's mini-waveform bitmap (and the doc channels reference
    // it holds) must not sit in the cache until unrelated churn evicts it (F9).
    for (const clipId of removedClipIds) purgeClipWaveform(clipId);
  },

  renameTrack(id, name) {
    set((s) => ({
      session: {
        ...s.session,
        tracks: s.session.tracks.map((t) => (t.id === id ? { ...t, name } : t)),
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
    // A dead clip's mini-waveform bitmap (and the doc channels reference it
    // holds) must not sit in the cache until unrelated churn evicts it (F9).
    purgeClipWaveform(clipId);
  },

  setClipGain(clipId, gainDb) {
    set((s) => {
      const loc = findClipLocation(s.session.tracks, clipId);
      if (!loc) return s;
      const clamped = Math.min(24, Math.max(-24, gainDb));
      const tracks = s.session.tracks.map((t, i) =>
        i === loc.trackIdx
          ? { ...t, clips: t.clips.map((c, j) => (j === loc.clipIdx ? { ...c, gainDb: clamped } : c)) }
          : t
      );
      return { session: { ...s.session, tracks } };
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

  setMtPlayState(state) {
    set({ mtPlayState: state });
  },

  setMtPlayheadSample(sample) {
    set({ mtPlayheadSample: sample });
  },
}));
