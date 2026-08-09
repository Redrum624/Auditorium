import { create } from 'zustand';
import type { Clip, Session, Track } from './session';
import { clampFadePair, createTrack, crossfadableOverlap } from './session';
import {
  clampAutomationValue,
  type AutomationKey,
  type AutomationLane,
  type AutomationParam,
} from './automation';
import { FADE_CURVES, type FadeCurve } from '../dsp/fades';
import {
  purgeClip as purgeClipWaveform,
  clearClipWaveformCache,
} from '../components/Multitrack/clipWaveformCache';
import { bindSessionUndo, recordSessionMutation } from './sessionUndo';

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
  /**
   * F0 — which track's envelope lane is open for editing, and for which
   * parameter (`null` = none). UI-only state, NEVER serialized: the lanes
   * themselves live on `Track.automation`; this is just the editing surface's
   * visibility. One open envelope at a time keeps the gesture surface
   * unambiguous (an open envelope overlay owns its lane's pointer events).
   */
  mtEnvelope: { trackId: string; param: AutomationParam } | null;
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
  /** F0 — adds or replaces one automation key. THIS ACTION IS THE AUTOMATION
   * WRITE BOUNDARY (the `setClipFade` pattern, trap T15): the UI hands raw
   * gesture output straight to it and must NOT re-implement the policy; both
   * audio engines read the stored lane without re-checking. The policy:
   *  - `key.positionSample` is rounded to the nearest integer and clamped
   *    `>= 0`; `key.value` is clamped to the parameter's range via the shared
   *    `clampAutomationValue` (volumeDb −60..+12 dB, pan −1..1). A non-finite
   *    position or value is a no-op (ignored, not clamped).
   *  - `key.curve` must be one of `FADE_CURVES` (checked at runtime); an
   *    unknown curve is dropped. When absent on a MOVE (see below), the moved
   *    key keeps the curve it had.
   *  - `replacePositionSample` makes the write a MOVE: the key at that exact
   *    position is removed in the same write (one commit, one tracks-array
   *    replacement — the drag gesture's pointerup calls this once).
   *  - Landing on an occupied position replaces that key — positions stay
   *    unique, and the lane stays ascending (re-sorted on every write).
   *  - The first key creates the lane (and the track's `automation` field);
   *    every write produces fresh key/lane/track arrays (trap T16). Unknown
   *    track id: no-op. */
  upsertAutomationKey(
    trackId: string,
    param: AutomationParam,
    key: { positionSample: number; value: number; curve?: FadeCurve },
    replacePositionSample?: number
  ): void;
  /** F5 — several params' keys in ONE tracks-array replacement: the spatial
   * positioner's drop writes azimuth AND distance together, and two separate
   * commits would fire the player's re-bake subscription twice (and leave a
   * torn position between them). Each write follows EXACTLY the
   * `upsertAutomationKey` policy — same helper, same clamps; an invalid
   * write in the batch is skipped (its valid siblings still land). Unknown
   * track id or an empty batch: no-op. */
  upsertAutomationKeys(
    trackId: string,
    writes: readonly {
      param: AutomationParam;
      key: { positionSample: number; value: number; curve?: FadeCurve };
      replacePositionSample?: number;
    }[]
  ): void;
  /** F0 — removes the key at the exact `positionSample`. An emptied lane is
   * removed, and a track whose last lane went is stripped of its `automation`
   * field entirely — ABSENT means none (traps T9/T11: an empty-but-present
   * field would serialize `"automation":[…]` into every save and redden the
   * byte-identity pin). Unknown track/param/position: no-op. */
  removeAutomationKey(trackId: string, param: AutomationParam, positionSample: number): void;
  /** F0 — sets the interpolation curve of the SEGMENT that starts at the key
   * at `positionSample` (each key's `curve` shapes the ramp to the NEXT key).
   * The curve is validated against `FADE_CURVES`; an unknown curve, track,
   * param or position is a no-op. */
  setAutomationKeyCurve(
    trackId: string,
    param: AutomationParam,
    positionSample: number,
    curve: FadeCurve
  ): void;
  setSelectedClip(id: string | null): void;
  /** F0 — opens/closes a track's envelope lane (see `mtEnvelope`). */
  setMtEnvelope(v: SessionState['mtEnvelope']): void;
  setMtCursor(s: number): void;
  setMtZoom(z: SessionState['mtZoom']): void;
  setMtPlayState(state: SessionState['mtPlayState']): void;
  setMtPlayheadSample(s: number): void;
}

function defaultMtZoom(): SessionState['mtZoom'] {
  return { samplesPerPixel: 512, scrollSample: 0 };
}

/**
 * THE automation upsert policy (trap T15 — one boundary, one arithmetic),
 * extracted so the single-key action and F5's batched multi-param action
 * cannot drift: position rounded and clamped `>= 0`, value clamped to the
 * param's range via the shared `clampAutomationValue`, non-finite input
 * rejected (`null` — the caller no-ops), curve validated against
 * `FADE_CURVES` with a MOVE carrying the moved key's own curve, landing on
 * an occupied position replacing that key, lane kept ascending, and every
 * array fresh (trap T16). Returns the track's next `automation` array.
 */
function upsertKeyIntoLanes(
  lanes: readonly AutomationLane[],
  param: AutomationParam,
  key: { positionSample: number; value: number; curve?: FadeCurve },
  replacePositionSample?: number
): AutomationLane[] | null {
  if (typeof key.positionSample !== 'number' || !Number.isFinite(key.positionSample)) return null;
  if (typeof key.value !== 'number' || !Number.isFinite(key.value)) return null;

  const pos = Math.max(0, Math.round(key.positionSample));
  const value = clampAutomationValue(param, key.value);
  const laneIdx = lanes.findIndex((l) => l.param === param);
  const oldKeys = laneIdx === -1 ? [] : lanes[laneIdx].keys;

  const replacePos =
    replacePositionSample !== undefined && Number.isFinite(replacePositionSample)
      ? Math.round(replacePositionSample)
      : undefined;
  const replaced =
    replacePos !== undefined ? oldKeys.find((k) => k.positionSample === replacePos) : undefined;
  // An explicit valid curve wins; a MOVE without one carries the moved
  // key's own curve so dragging a key never silently resets its segment.
  const curve =
    key.curve !== undefined && (FADE_CURVES as readonly string[]).includes(key.curve)
      ? key.curve
      : replaced?.curve;

  const nextKey: AutomationKey = { positionSample: pos, value };
  if (curve !== undefined) nextKey.curve = curve;
  const kept = oldKeys.filter(
    (k) => k.positionSample !== pos && (replacePos === undefined || k.positionSample !== replacePos)
  );
  const keys = [...kept, nextKey].sort((a, b) => a.positionSample - b.positionSample);
  const lane: AutomationLane = { param, keys };
  return laneIdx === -1 ? [...lanes, lane] : lanes.map((l, i) => (i === laneIdx ? lane : l));
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
  /** True when the pair was an armed canonical pair BY ITS OWN GEOMETRY AND
   * FADES (rules 1/2 + both facing fades exactly spanning the overlap).
   * Deliberately INTRUSION-BLIND (X4, carried X5 finding): an armed pair a
   * later `addClip`/punch-in intruded on is only SILENCED at the renderer
   * (rule 4) — its stored fades still mark it as armed, and reading it as
   * not-armed here made moving a member away skip the disarm and strand the
   * partner's facing fade as a surprise solo fade. */
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
      // Pair-only geometry ([pivot, n], not the whole track): rule 4 must NOT
      // decide armed-ness here. An intruder silences the crossfade at the
      // renderer while the stored fades keep the pair armed; snapshotting it
      // as not-armed skipped the disarm on a later move-away (X5 finding,
      // fixed in X4). The ARM pass still runs the full-track predicate, so an
      // intruded pair can never be (re-)armed through this eligibility.
      const geo = crossfadableOverlap([pivot, n], pivot, n);
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
    // Latent-pair guard (X4, carried X5 finding): an armed pair the arm pass
    // could not re-arm ONLY because an intruder trips rule 4 may still be an
    // exact canonical pair by its own geometry — same orientation, both
    // facing fades still spanning the (possibly unchanged) overlap. Its
    // fades are not stale: the renderer merely silences them while the
    // intruder sits there, and removing the intruder revives the crossfade
    // with no store write (pinned X5 behaviour). Clearing here would destroy
    // that. The orientation term matters: a flipped re-arm at the same width
    // writes the OPPOSITE edges, and the stale originals must still fall
    // through to the clears below.
    const pivotNow = clips.find((c) => c.id === pivotId);
    const mateNow = clips.find((c) => c.id === mateId);
    if (pivotNow && mateNow) {
      const geoNow = crossfadableOverlap([pivotNow, mateNow], pivotNow, mateNow);
      const outId = preState.pivotEdge === 'out' ? pivotId : mateId;
      if (
        geoNow !== null &&
        geoNow.a.id === outId &&
        (geoNow.a.fadeOutSample ?? 0) === geoNow.width &&
        (geoNow.b.fadeInSample ?? 0) === geoNow.width
      ) {
        continue;
      }
    }
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

/** R3 — the History label for a `setTrackParam` patch. Call sites pass
 * single-key patches (sliders, the M/S/R toggles); a multi-key or unknown
 * patch falls back to the generic label rather than guessing. */
function trackParamLabel(patch: Partial<Pick<Track, 'volumeDb' | 'pan' | 'muted' | 'solo' | 'armed'>>): string {
  const keys = Object.keys(patch);
  if (keys.length !== 1) return 'Edit track';
  switch (keys[0]) {
    case 'volumeDb':
      return 'Set track volume';
    case 'pan':
      return 'Set track pan';
    case 'muted':
      return patch.muted ? 'Mute track' : 'Unmute track';
    case 'solo':
      return patch.solo ? 'Solo track' : 'Unsolo track';
    case 'armed':
      return patch.armed ? 'Arm track' : 'Disarm track';
    default:
      return 'Edit track';
  }
}

/** R3 — the coalescing key for a `setTrackParam` patch: only the CONTINUOUS
 * params coalesce (a slider's keyboard arrow fires one store write per repeat
 * tick — without merging, one held key would flood `UNDO_LIMIT`). The
 * discrete toggles never coalesce: mute-then-unmute merged into one entry
 * would be a no-op entry, and each toggle is a deliberate act. Keyed per
 * (track, param) so adjusting two different faders never merges. */
function trackParamCoalesceKey(
  id: string,
  patch: Partial<Pick<Track, 'volumeDb' | 'pan' | 'muted' | 'solo' | 'armed'>>
): string | undefined {
  const keys = Object.keys(patch);
  if (keys.length !== 1) return undefined;
  return keys[0] === 'volumeDb' || keys[0] === 'pan' ? `trackParam:${id}:${keys[0]}` : undefined;
}

export const useSessionStore = create<SessionState & SessionActions>()((set) => ({
  session: makeSession(44100),
  selectedClipId: null,
  mtCursorSample: 0,
  mtZoom: defaultMtZoom(),
  mtPlayState: 'stopped',
  mtPlayheadSample: 0,
  mtEnvelope: null,

  newSession(sampleRate) {
    // R3: recorded — File > New Session is a store mutation of the current
    // timeline (undo restores the discarded session), unlike the load-shaped
    // replacements (Open Session, stem landing) which CLEAR the history.
    recordSessionMutation('New session', () => {
      set({
        session: makeSession(sampleRate),
        selectedClipId: null,
        mtCursorSample: 0,
        mtZoom: defaultMtZoom(),
        mtPlayState: 'stopped',
        mtPlayheadSample: 0,
        mtEnvelope: null,
      });
    });
    // A fresh session discards every track/clip that could own a cached
    // mini-waveform bitmap (F9) — clear the whole cache rather than track
    // which entries belonged to the discarded session.
    clearClipWaveformCache();
  },

  addTrack() {
    recordSessionMutation('Add track', () => {
      set((s) => {
        const name = `Track ${s.session.tracks.length + 1}`;
        return { session: { ...s.session, tracks: [...s.session.tracks, createTrack(name)] } };
      });
    });
  },

  removeTrack(id) {
    // Captured inside the set() updater below so the post-set purge (F9) knows
    // exactly which clips died with the track, without a second state lookup.
    let removedClipIds: string[] = [];
    recordSessionMutation('Remove track', () => {
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
    });
    // Each removed clip's mini-waveform bitmap (and the doc channels reference
    // it holds) must not sit in the cache until unrelated churn evicts it (F9).
    for (const clipId of removedClipIds) purgeClipWaveform(clipId);
  },

  renameTrack(id, name) {
    recordSessionMutation('Rename track', () => {
      set((s) => {
        // R3 no-op guard: an unknown id, or a blur that re-commits the
        // unchanged name, must return the SAME state — a rebuilt-but-equal
        // session would mint a noise undo entry (recording keys on the
        // session reference). Same rationale for the guards added to
        // setTrackParam/addClip/setClipGain/setClipFade below.
        const track = s.session.tracks.find((t) => t.id === id);
        if (!track || track.name === name) return s;
        return {
          session: {
            ...s.session,
            tracks: s.session.tracks.map((t) => (t.id === id ? { ...t, name } : t)),
          },
        };
      });
    });
  },

  setTrackParam(id, patch) {
    recordSessionMutation(
      trackParamLabel(patch),
      () => {
        set((s) => {
          const track = s.session.tracks.find((t) => t.id === id);
          if (!track) return s; // R3 no-op guard (see renameTrack)
          const keys = Object.keys(patch) as (keyof typeof patch)[];
          if (keys.every((k) => track[k] === patch[k])) return s;
          return {
            session: {
              ...s.session,
              tracks: s.session.tracks.map((t) => (t.id === id ? { ...t, ...patch } : t)),
            },
          };
        });
      },
      trackParamCoalesceKey(id, patch)
    );
  },

  addClip(trackId, clip) {
    recordSessionMutation('Add clip', () => {
      set((s) => {
        if (!s.session.tracks.some((t) => t.id === trackId)) return s; // R3 no-op guard
        return {
          session: {
            ...s.session,
            tracks: s.session.tracks.map((t) =>
              t.id === trackId ? { ...t, clips: insertSorted(t.clips, clip) } : t
            ),
          },
        };
      });
    });
  },

  moveClip(clipId, toTrackId, newStartSample, opts) {
    recordSessionMutation('Move clip', () => {
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
    });
  },

  trimClip(clipId, edge, newBoundarySample) {
    recordSessionMutation('Trim clip', () => {
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
    });
  },

  removeClip(clipId) {
    recordSessionMutation('Remove clip', () => {
      set((s) => {
        const loc = findClipLocation(s.session.tracks, clipId);
        if (!loc) return s;
        const clip = s.session.tracks[loc.trackIdx].clips[loc.clipIdx];
        // X5/v1.9.1: snapshot the pivot's overlap relationships BEFORE it leaves
        // the array (trap T5). preOverlapStates skips the pivot and measures every
        // overlap against it, so it must run while the pivot is still present —
        // snapshotting after the filter reads every pair as unarmed and disarms
        // nothing. With the pivot then filtered out, maintainFacingFades re-arms
        // nothing (its arm loop finds no pivot -> continue) and its disarm loop
        // clears the survivor's now-stale facing edge, so deleting one member of
        // an armed crossfade pair no longer strands the survivor's facing fade as
        // a surprise solo fade. The dead pivot's own facing-edge write is a no-op
        // (writeClipFade's index guard). Reuses the existing helper verbatim — no
        // bespoke disarm logic (trap T6).
        const pre = preOverlapStates(s.session.tracks[loc.trackIdx].clips, clip);
        const tracks = s.session.tracks.map((t, i) =>
          i === loc.trackIdx ? { ...t, clips: t.clips.filter((c) => c.id !== clipId) } : t
        );
        maintainFacingFades(tracks, loc.trackIdx, loc.trackIdx, clipId, pre);
        const selectedClipId = s.selectedClipId === clipId ? null : s.selectedClipId;
        return { session: { ...s.session, tracks }, selectedClipId };
      });
    });
    // A dead clip's mini-waveform bitmap (and the doc channels reference it
    // holds) must not sit in the cache until unrelated churn evicts it (F9).
    purgeClipWaveform(clipId);
  },

  setClipGain(clipId, gainDb) {
    recordSessionMutation('Set clip gain', () => {
      set((s) => {
        const loc = findClipLocation(s.session.tracks, clipId);
        if (!loc) return s;
        const clamped = Math.min(24, Math.max(-24, gainDb));
        // R3 no-op guard (see renameTrack): re-committing the unchanged gain
        // (a blur without an edit) must not mint a noise undo entry.
        if (s.session.tracks[loc.trackIdx].clips[loc.clipIdx].gainDb === clamped) return s;
        const tracks = s.session.tracks.map((t, i) =>
          i === loc.trackIdx
            ? { ...t, clips: t.clips.map((c, j) => (j === loc.clipIdx ? { ...c, gainDb: clamped } : c)) }
            : t
        );
        return { session: { ...s.session, tracks } };
      });
    });
  },

  setClipFade(clipId, edge, fade) {
    recordSessionMutation('Set fade', () => {
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
        // R3 no-op guard (see renameTrack): a patch whose every key already
        // holds the stored value (a blur without an edit; a fade-handle click
        // that never dragged) must not mint a noise undo entry.
        if ((Object.keys(patch) as (keyof Clip)[]).every((k) => clip[k] === patch[k])) return s;

        const tracks = s.session.tracks.map((t, i) =>
          i === loc.trackIdx
            ? { ...t, clips: t.clips.map((c, j) => (j === loc.clipIdx ? { ...c, ...patch } : c)) }
            : t
        );
        return { session: { ...s.session, tracks } };
      });
    });
  },

  upsertAutomationKey(trackId, param, key, replacePositionSample) {
    recordSessionMutation(replacePositionSample !== undefined ? 'Move automation key' : 'Add automation key', () => {
      set((s) => {
        const idx = s.session.tracks.findIndex((t) => t.id === trackId);
        if (idx === -1) return s;
        const t = s.session.tracks[idx];
        const automation = upsertKeyIntoLanes(t.automation ?? [], param, key, replacePositionSample);
        if (automation === null) return s;
        const tracks = s.session.tracks.map((tr, i) => (i === idx ? { ...tr, automation } : tr));
        return { session: { ...s.session, tracks } };
      });
    });
  },

  upsertAutomationKeys(trackId, writes) {
    recordSessionMutation('Edit automation', () => {
      set((s) => {
        const idx = s.session.tracks.findIndex((t) => t.id === trackId);
        if (idx === -1) return s;
        const t = s.session.tracks[idx];
        let automation = t.automation ?? [];
        let changed = false;
        for (const w of writes) {
          const next = upsertKeyIntoLanes(automation, w.param, w.key, w.replacePositionSample);
          if (next === null) continue; // invalid member: skipped, siblings land
          automation = next;
          changed = true;
        }
        if (!changed) return s;
        const tracks = s.session.tracks.map((tr, i) => (i === idx ? { ...tr, automation } : tr));
        return { session: { ...s.session, tracks } };
      });
    });
  },

  removeAutomationKey(trackId, param, positionSample) {
    recordSessionMutation('Remove automation key', () => {
      set((s) => {
        const idx = s.session.tracks.findIndex((t) => t.id === trackId);
        if (idx === -1) return s;
        if (typeof positionSample !== 'number' || !Number.isFinite(positionSample)) return s;
        const t = s.session.tracks[idx];
        const lanes = t.automation;
        if (!lanes) return s;
        const laneIdx = lanes.findIndex((l) => l.param === param);
        if (laneIdx === -1) return s;

        const pos = Math.round(positionSample);
        const keys = lanes[laneIdx].keys.filter((k) => k.positionSample !== pos);
        if (keys.length === lanes[laneIdx].keys.length) return s; // nothing at that position

        const automation =
          keys.length > 0
            ? lanes.map((l, i) => (i === laneIdx ? { param, keys } : l))
            : lanes.filter((_, i) => i !== laneIdx);
        const tracks = s.session.tracks.map((tr, i) => {
          if (i !== idx) return tr;
          if (automation.length > 0) return { ...tr, automation };
          // Last lane gone: the field itself goes — absent means none (T9/T11).
          const stripped = { ...tr };
          delete stripped.automation;
          return stripped;
        });
        return { session: { ...s.session, tracks } };
      });
    });
  },

  setAutomationKeyCurve(trackId, param, positionSample, curve) {
    recordSessionMutation('Set automation curve', () => {
      set((s) => {
        if (!(FADE_CURVES as readonly string[]).includes(curve)) return s;
        const idx = s.session.tracks.findIndex((t) => t.id === trackId);
        if (idx === -1) return s;
        if (typeof positionSample !== 'number' || !Number.isFinite(positionSample)) return s;
        const t = s.session.tracks[idx];
        const lanes = t.automation;
        if (!lanes) return s;
        const laneIdx = lanes.findIndex((l) => l.param === param);
        if (laneIdx === -1) return s;
        const pos = Math.round(positionSample);
        const keyIdx = lanes[laneIdx].keys.findIndex((k) => k.positionSample === pos);
        if (keyIdx === -1) return s;

        const keys = lanes[laneIdx].keys.map((k, i) => (i === keyIdx ? { ...k, curve } : k));
        const automation = lanes.map((l, i) => (i === laneIdx ? { param, keys } : l));
        const tracks = s.session.tracks.map((tr, i) => (i === idx ? { ...tr, automation } : tr));
        return { session: { ...s.session, tracks } };
      });
    });
  },

  setSelectedClip(id) {
    set({ selectedClipId: id });
  },

  setMtEnvelope(v) {
    set({ mtEnvelope: v });
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

// R3 — binds the session undo plumbing to this store (one-way dependency:
// this module imports sessionUndo, never the reverse). The snapshot is
// `{ session, selectedClipId }` — see SessionSnapshot in sessionUndo.ts for
// the ruling-3 view-state pin. `apply` also maintains the F9 cache
// discipline the ORIGINAL mutations maintain out-of-band: `removeClip`/
// `removeTrack` purge dead clips' mini-waveform bitmaps after their set(),
// but an undo/redo swaps whole snapshots without re-running the action, so
// the purge is re-derived here by diffing clip ids — a clip present before
// the swap but absent after it is dead and its bitmap (holding a doc
// channels reference) must not linger until unrelated churn evicts it.
bindSessionUndo({
  capture: () => {
    const s = useSessionStore.getState();
    return { session: s.session, selectedClipId: s.selectedClipId };
  },
  apply: (snapshot) => {
    const before = useSessionStore.getState().session;
    useSessionStore.setState({
      session: snapshot.session,
      selectedClipId: snapshot.selectedClipId,
    });
    if (before !== snapshot.session) {
      const kept = new Set<string>();
      for (const t of snapshot.session.tracks) for (const c of t.clips) kept.add(c.id);
      for (const t of before.tracks) {
        for (const c of t.clips) if (!kept.has(c.id)) purgeClipWaveform(c.id);
      }
    }
  },
});
