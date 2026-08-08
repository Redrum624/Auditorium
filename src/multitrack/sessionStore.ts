import { create } from 'zustand';
import type { Clip, Session, Track } from './session';
import { clampFadePair, createTrack, crossfadableOverlap } from './session';
import { FADE_CURVES, type FadeCurve } from '../dsp/fades';
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
  /** OVERLAP CONTRACT (v1.9 X5 — unified; this replaces the recorded v1.8
   * inconsistency where `moveClip` alone nudged clear). Same-track overlap is
   * FIRST-CLASS: every placement path accepts it, and what distinguishes the
   * paths is only whether they SHAPE it:
   *  - `addClip` inserts sorted and accepts an overlapping clip VERBATIM.
   *    Insert Active File (`menuActions.ts`'s `insertActiveDocAsClip`) drops
   *    the clip at the cursor and punch-in recording (`multitrackRecord.ts`)
   *    at the punch-in sample; neither checks what is already there, and a
   *    programmatic placement never writes fade keys — inventing a crossfade
   *    around a recorded take is not this layer's call.
   *  - `moveClip` commits the requested position verbatim by default; a drag
   *    that creates or maintains an overlap arms/maintains the pair's facing
   *    fades (see `maintainFacingFades`) so it renders as X3's canonical-pair
   *    crossfade. `opts.clearOverlap` — the drag gesture's Ctrl modifier —
   *    re-enables the v1.8 forward-only nudge (`resolveOverlap`) instead.
   *  - `trimClip` can extend a clip over its neighbour; it runs the same
   *    facing-fade maintenance, so a trim that reshapes an armed crossfade
   *    re-arms it at the new width instead of silently disarming it.
   * An overlap whose facing fades do NOT exactly span it (a raw layering
   * choice, a vetoed arm, a pile-up) renders as honest solo fades over a raw
   * sum, hard-clamped to +/-1 in `mixdown.ts`, so it can clip — see
   * `resolveClipFadeSpecs` for the render-side gate. */
  addClip(trackId: string, clip: Clip): void; // inserts sorted; accepts overlap verbatim; never writes fades
  moveClip(clipId: string, toTrackId: string, newStartSample: number, opts?: { clearOverlap?: boolean }): void; // clamps >=0; commits verbatim + maintains facing fades; opts.clearOverlap = v1.8 nudge
  trimClip(clipId: string, edge: 'start' | 'end', newBoundarySample: number): void; // adjusts offset/length, min 32; may overlap a neighbour; re-clamps fades (X2 — see setClipFade) and maintains facing fades on the overlap it reshapes (X5)
  removeClip(clipId: string): void;
  /** Sets a clip's gain trim in dB, clamped to [-24, 24]. No-op for an unknown
   * clip id. Additive (Task 23): wired to the PropertiesPanel's clip gain input. */
  setClipGain(clipId: string, gainDb: number): void;
  /** Sets one edge's fade length and/or curve (v1.9 X2). THIS ACTION IS THE
   * CLAMP BOUNDARY — the single place the fade policy lives. X4 binds UI
   * inputs (handle drags, the Properties panel) straight to it and must NOT
   * re-implement the clamp; X3 reads the stored values without re-checking.
   *
   * The policy, exactly:
   *  - `fade.lengthSample` (samples at session rate) is rounded to the nearest
   *    integer, then clamped to `[0, clip.lengthSample - otherFade]` — a fade
   *    can never exceed its clip and can never cross the opposite fade. The
   *    STANDING fade wins: asking for more room than the other fade leaves
   *    shortens the requested fade, never the standing one. (Fades may MEET —
   *    `fadeIn + fadeOut === lengthSample` is legal.)
   *  - A resulting length of 0 is stored as `undefined` ("no fade"), so a
   *    cleared fade writes no key into a saved `.audm`.
   *  - A non-finite `lengthSample` (NaN/Infinity) is ignored, not clamped.
   *  - `fade.curve` must be one of `FADE_CURVES` (checked at runtime — the
   *    type doesn't protect a JS caller); an unknown curve is ignored. A curve
   *    may be set while the fade length is 0/absent: the choice persists and
   *    takes effect when the fade gets a length.
   *  - Unknown clip id, or a patch with nothing valid in it: no-op.
   *
   * The same pair invariant is re-established by `trimClip` when a trim
   * shrinks the clip under an existing fade (there, the fade at the TRIMMED
   * edge yields — see `reconcileTrimmedFades`) and by `sessionFile.ts` against
   * hand-edited/foreign files at parse time. */
  setClipFade(clipId: string, edge: 'in' | 'out', fade: { lengthSample?: number; curve?: FadeCurve }): void;
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
 * `clips` (the moving clip removed). Since X5 the nudge is OPT-IN:
 * `moveClip` — still its only caller — runs it only under
 * `opts.clearOverlap` (the drag gesture's Ctrl modifier); by default a
 * requested overlap commits verbatim (see the overlap contract on `addClip`).
 *
 * The single forward pass is sound only over an ASCENDING scan: `candidate`
 * only ever moves forward to the end of a clip it overlapped, so a clip
 * visited EARLIER whose start lies AFTER the current candidate could be
 * re-entered by a later jump and never re-checked (trap T39's
 * counterexample). The array itself cannot be trusted to be ascending —
 * `trimClip('start')` writes in place without re-sorting (T40) — so the scan
 * orders a copy first instead of assuming. */
function resolveOverlap(clips: readonly Clip[], length: number, requestedStart: number): number {
  const ascending = [...clips].sort((x, y) => x.startSample - y.startSample);
  let candidate = Math.max(0, requestedStart);
  for (const c of ascending) {
    const clipEnd = c.startSample + c.lengthSample;
    const candidateEnd = candidate + length;
    const overlaps = candidate < clipEnd && candidateEnd > c.startSample;
    if (overlaps) candidate = clipEnd;
  }
  return candidate;
}

/** Plain interval intersection of two clips' spans — 0 when they do not
 * overlap. Distinguishes an overlap a gesture CREATED (pre-gesture width 0)
 * from one it merely repositioned (see `maintainFacingFades`). */
function rawOverlapWidth(m: Clip, n: Clip): number {
  const lo = Math.max(m.startSample, n.startSample);
  const hi = Math.min(m.startSample + m.lengthSample, n.startSample + n.lengthSample);
  return Math.max(0, hi - lo);
}

interface PreOverlapState {
  /** Raw overlap width with the pivot before the gesture (0 = none). */
  width: number;
  /** True when the pair was a fully-armed canonical pair (crossfade-capable
   * geometry AND both facing fades exactly spanning the overlap). */
  armed: boolean;
  /** The PIVOT's facing edge in that armed pair ('out' when the pivot was the
   * outgoing/earlier side), null when not armed. */
  pivotEdge: 'in' | 'out' | null;
}

/** Snapshot of the pivot clip's overlap relationships on its track BEFORE a
 * gesture edit — the memory `maintainFacingFades` needs afterwards to tell a
 * crossfade it must maintain (armed) from a raw layering choice it must not
 * touch (overlapped but unarmed). */
function preOverlapStates(clips: readonly Clip[], pivot: Clip): Map<string, PreOverlapState> {
  const map = new Map<string, PreOverlapState>();
  for (const n of clips) {
    if (n.id === pivot.id) continue;
    const width = rawOverlapWidth(pivot, n);
    let armed = false;
    let pivotEdge: 'in' | 'out' | null = null;
    if (width > 0) {
      const geo = crossfadableOverlap(clips, pivot, n);
      if (geo && (geo.a.fadeOutSample ?? 0) === geo.width && (geo.b.fadeInSample ?? 0) === geo.width) {
        armed = true;
        pivotEdge = geo.a.id === pivot.id ? 'out' : 'in';
      }
    }
    map.set(n.id, { width, armed, pivotEdge });
  }
  return map;
}

/** Replaces the identified clip with a copy whose named fade length is
 * `lengthSample` (`undefined` = "no fade"; curves are never touched). */
function writeClipFade(
  clips: Clip[],
  clipId: string,
  edge: 'in' | 'out',
  lengthSample: number | undefined
): void {
  const idx = clips.findIndex((c) => c.id === clipId);
  if (idx === -1) return;
  const c = clips[idx];
  clips[idx] = edge === 'in' ? { ...c, fadeInSample: lengthSample } : { ...c, fadeOutSample: lengthSample };
}

/** X5 — facing-fade maintenance: the store's half of X3's canonical-pair
 * contract ("the gesture keeps both facing fades exactly equal to the overlap
 * width, or the overlap silently renders as solo fades"). Runs after a
 * `moveClip`/`trimClip` edit has been applied to `tracks` (a draft whose
 * affected clips arrays are fresh copies), with `pre` snapshotted via
 * `preOverlapStates` before the edit. For each track-mate N of the edited
 * (pivot) clip:
 *
 *  - ARM — write `a.fadeOutSample = b.fadeInSample = width` — exactly when
 *    the post-edit pair has crossfade-capable geometry (`crossfadableOverlap`,
 *    X3's rules 1/2/4) AND the overlap is either NEW (pre-gesture width 0:
 *    this gesture produced it) or was ALREADY ARMED (a live crossfade tracks
 *    the width the gesture gives it — closing the "a trim silently disarms
 *    the crossfade" gap X3's report flagged) AND both AWAY-side fades leave
 *    room (`awayFade + width <= lengthSample` on each member). A standing
 *    fade the gesture did not touch is never shrunk — clip mutations have no
 *    undo, so silently destroying one is data loss; the vetoed pair simply
 *    stays un-armed, an honest raw sum. An existing UN-armed overlap is
 *    deliberately not armed either: bare raw sums and partial facing fades
 *    are legitimate states (X3's honest fallback) and repositioning a clip
 *    must not overwrite them.
 *  - DISARM — a pair that was armed and whose facing edges were not re-armed
 *    by this edit has been dissolved (moved apart, geometry now containment /
 *    equal-start / pile-up, or the re-arm was vetoed): BOTH stale facing
 *    fades are cleared so no mismatched pair lingers as surprise solo fades.
 *    Away-side fades are untouched.
 *
 * Fades are written only for integer widths: fractional geometry can only
 * come from a hand-built file (gesture arithmetic is all rounded), and the
 * renderer's `=== width` gate compares unrounded, so a rounded write could
 * never fire. `addClip` deliberately gets none of this — a programmatic
 * placement (punch-in, Insert Active File, session load) lands verbatim and
 * never invents fades (see the overlap contract above). */
function maintainFacingFades(
  tracks: Track[],
  pivotTrackIdx: number,
  preTrackIdx: number,
  pivotId: string,
  pre: Map<string, PreOverlapState>
): void {
  const clips = tracks[pivotTrackIdx].clips;
  const armedNow = new Set<string>(); // "clipId:edge" freshly written by this pass

  const mateIds = clips.filter((c) => c.id !== pivotId).map((c) => c.id);
  for (const mateId of mateIds) {
    // Re-resolve both members from the live array each iteration: an earlier
    // arm in this pass may have replaced either object (e.g. a chain where
    // the pivot arms at both edges), and the away-room check below must see
    // the freshly-written value, not a stale reference.
    const pivot = clips.find((c) => c.id === pivotId);
    const mate = clips.find((c) => c.id === mateId);
    if (!pivot || !mate) continue;
    const geo = crossfadableOverlap(clips, pivot, mate);
    if (!geo || !Number.isInteger(geo.width)) continue;
    const preState = pre.get(mateId);
    const eligible = preState === undefined || preState.width === 0 || preState.armed;
    if (!eligible) continue;
    const roomOk =
      (geo.a.fadeInSample ?? 0) + geo.width <= geo.a.lengthSample &&
      (geo.b.fadeOutSample ?? 0) + geo.width <= geo.b.lengthSample;
    if (!roomOk) continue;
    writeClipFade(clips, geo.a.id, 'out', geo.width);
    writeClipFade(clips, geo.b.id, 'in', geo.width);
    armedNow.add(`${geo.a.id}:out`);
    armedNow.add(`${geo.b.id}:in`);
  }

  // Disarm: clear the facing edges of every previously-armed pair, except
  // edges the arm pass above just rewrote (a re-arm at a new width, or a new
  // pair claiming the same edge). Keyed per (clip, edge) so a pair that
  // re-armed with FLIPPED orientation still has its stale edges cleared.
  for (const [mateId, preState] of pre) {
    if (!preState.armed || preState.pivotEdge === null) continue;
    const mateEdge = preState.pivotEdge === 'out' ? 'in' : 'out';
    if (!armedNow.has(`${pivotId}:${preState.pivotEdge}`)) {
      writeClipFade(tracks[pivotTrackIdx].clips, pivotId, preState.pivotEdge, undefined);
    }
    if (!armedNow.has(`${mateId}:${mateEdge}`)) {
      writeClipFade(tracks[preTrackIdx].clips, mateId, mateEdge, undefined);
    }
  }
}

/** v1.9 X2 (trap T17): a trim that shortens a clip must leave its fades
 * coherent — the spread in `trimClip` carries `fadeInSample`/`fadeOutSample`
 * over unchanged, so without this they could exceed the new `lengthSample` or
 * cross each other. Policy: the fade anchored at the UN-trimmed edge is
 * preserved (clamped only by the new clip length); the fade at the trimmed
 * edge — the one visually colliding with the boundary the user is dragging —
 * yields what room remains. A fade squeezed to 0 is normalized back to
 * `undefined` so it leaves no key behind. Fade-free clips pass through
 * untouched. Kept as its own function so X5's coming `trimClip` changes and
 * this fade re-clamp stay separable (coupling C5). */
function reconcileTrimmedFades(clip: Clip, trimmedEdge: 'start' | 'end'): Clip {
  const fadeIn = clip.fadeInSample ?? 0;
  const fadeOut = clip.fadeOutSample ?? 0;
  if (fadeIn === 0 && fadeOut === 0) return clip;
  // trimmed 'start' edge => the fade-in yields => the fade-OUT has priority.
  const priority = trimmedEdge === 'start' ? 'out' : 'in';
  const next = clampFadePair(fadeIn, fadeOut, clip.lengthSample, priority);
  if (next.fadeIn === fadeIn && next.fadeOut === fadeOut) return clip;
  return {
    ...clip,
    fadeInSample: next.fadeIn > 0 ? next.fadeIn : undefined,
    fadeOutSample: next.fadeOut > 0 ? next.fadeOut : undefined,
  };
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

  moveClip(clipId, toTrackId, newStartSample, opts) {
    set((s) => {
      const loc = findClipLocation(s.session.tracks, clipId);
      const targetTrackIdx = s.session.tracks.findIndex((t) => t.id === toTrackId);
      if (!loc || targetTrackIdx === -1) return s;

      const clip = s.session.tracks[loc.trackIdx].clips[loc.clipIdx];
      // Snapshot BEFORE the move: which mates the clip overlapped, and which
      // of those overlaps were armed crossfades (see maintainFacingFades).
      const pre = preOverlapStates(s.session.tracks[loc.trackIdx].clips, clip);
      const tracks = s.session.tracks.map((t) => ({ ...t, clips: [...t.clips] }));
      tracks[loc.trackIdx].clips.splice(loc.clipIdx, 1);

      const requestedStart = Math.max(0, newStartSample);
      // X5: the requested (snapped) position commits VERBATIM by default —
      // overlap is intentional. The v1.8 forward-only nudge survives behind
      // opts.clearOverlap (the drag gesture's Ctrl modifier).
      const resolvedStart = opts?.clearOverlap
        ? resolveOverlap(tracks[targetTrackIdx].clips, clip.lengthSample, requestedStart)
        : requestedStart;
      const movedClip: Clip = { ...clip, startSample: resolvedStart };
      tracks[targetTrackIdx].clips = insertSorted(tracks[targetTrackIdx].clips, movedClip);

      maintainFacingFades(tracks, targetTrackIdx, loc.trackIdx, clipId, pre);
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
      updated = reconcileTrimmedFades(updated, edge); // X2: fades must stay within the new length

      // Snapshot BEFORE the trim (see maintainFacingFades), then write the
      // trimmed clip back IN PLACE at clipIdx — deliberately no re-sort, so
      // X2's index-stable update contract holds (and trap T40 remains a fact
      // consumers must handle, which the maintenance below does: it pairs by
      // startSample, never by array position).
      const pre = preOverlapStates(s.session.tracks[loc.trackIdx].clips, clip);
      const tracks = s.session.tracks.map((t, i) =>
        i === loc.trackIdx ? { ...t, clips: t.clips.map((c, j) => (j === loc.clipIdx ? updated : c)) } : t
      );
      maintainFacingFades(tracks, loc.trackIdx, loc.trackIdx, clipId, pre);
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

  setClipFade(clipId, edge, fade) {
    set((s) => {
      const loc = findClipLocation(s.session.tracks, clipId);
      if (!loc) return s;
      const clip = s.session.tracks[loc.trackIdx].clips[loc.clipIdx];

      const patch: Partial<Clip> = {};
      if (fade.lengthSample !== undefined && Number.isFinite(fade.lengthSample)) {
        const requested = Math.round(fade.lengthSample);
        // The STANDING (opposite) fade has priority: clampFadePair preserves
        // it and gives the edited fade only the room that remains. See the
        // full policy on the SessionActions declaration.
        const pair =
          edge === 'in'
            ? clampFadePair(requested, clip.fadeOutSample ?? 0, clip.lengthSample, 'out')
            : clampFadePair(clip.fadeInSample ?? 0, requested, clip.lengthSample, 'in');
        // Both sides are written back: normally only the edited one changes,
        // but if the standing fade ever arrived out of range (an invariant
        // breach upstream) this heals it rather than preserving the breach.
        patch.fadeInSample = pair.fadeIn > 0 ? pair.fadeIn : undefined;
        patch.fadeOutSample = pair.fadeOut > 0 ? pair.fadeOut : undefined;
      }
      if (fade.curve !== undefined && (FADE_CURVES as readonly string[]).includes(fade.curve)) {
        if (edge === 'in') patch.fadeInCurve = fade.curve;
        else patch.fadeOutCurve = fade.curve;
      }
      if (Object.keys(patch).length === 0) return s;

      const tracks = s.session.tracks.map((t, i) =>
        i === loc.trackIdx
          ? { ...t, clips: t.clips.map((c, j) => (j === loc.clipIdx ? { ...c, ...patch } : c)) }
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
