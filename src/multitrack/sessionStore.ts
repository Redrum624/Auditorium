import { create } from 'zustand';
import { nextId } from '../audio/AudioDocument';
import type { Clip, Session, Track } from './session';
import { clampFadePair, createTrack, crossfadableOverlap } from './session';
import {
  clampAutomationValue,
  type AutomationKey,
  type AutomationLane,
  type AutomationParam,
} from './automation';
import { FADE_CURVES, type FadeCurve } from '../dsp/fades';
import { bindSessionUndo, recordSessionMutation, withSessionGesture } from './sessionUndo';
// MT1-1: the session's zoom limits live in one module now, so this store states
// requests and `resolveSessionZoom` answers them — the shape `appStore` took in
// F11-9. The store-touching writers (`applySessionZoom`,
// `publishSessionLaneWidth`) are at the bottom of this file, next to
// `setMtZoom`, exactly as the editor's live next to `setZoom`.
import {
  defaultSessionZoom,
  fitSessionSamplesPerPixel,
  resolveSessionZoom,
  sessionTimelineLength,
  type SessionZoomRequest,
} from './sessionZoom';
import { laneWidthFromScrollerWidth, sessionLaneWidth, setSessionLaneWidth } from './sessionViewport';
import { clampGroupDelta } from './groupDrag'; // T5
import { closeGapShifts, gapAt, gapProbeSample, type TrackGap } from './gaps'; // D3

export interface SessionState {
  session: Session;
  selectedClipId: string | null;
  /**
   * K1 — the EXTENDED clip selection (Ctrl+Click), view state beside the
   * primary above rather than a replacement for it. Two invariants, held by
   * every writer and re-established by `reconcileSelection` after any session
   * change:
   *
   *   1. `selectedClipId === null` iff this array is empty;
   *   2. a non-null primary is always a member of this array.
   *
   * So every existing single-selection consumer — the Properties panel's
   * fields, the fade handles, the gesture code — keeps reading
   * `selectedClipId` and keeps meaning exactly what it meant before K1. What
   * the SET adds is the group verbs and nothing else: group drag, Delete,
   * Ripple Delete, and the panel's "N clips selected" header.
   *
   * NOT in `SessionSnapshot` (ruling 3 stands): an undo restores
   * `{session, selectedClipId}`, and this array is reconciled against the
   * session that came back — members whose clips are gone drop out, and the
   * restored primary is put back in. That is the same treatment the cursor
   * gets, for the same reason: remembering a selection would yank the user's
   * working set around for no comprehension gain, while an array pointing at
   * clips that no longer exist would be a dangling reference the group verbs
   * would then act on.
   */
  selectedClipIds: string[];
  /**
   * D3 — the selected GAP: the empty span on ONE track the user double-clicked
   * (`gaps.ts` defines what counts), or `null`. The multitrack's second kind of
   * selection, and deliberately never a THIRD state on screen: selecting a gap
   * clears the clip selection and every clip-selection writer clears this, so
   * exactly one of the two is standing at any moment. Delete / Ripple Delete
   * read whichever it is.
   *
   * UI-only state, in the sense `mtEnvelope` and `groupDragPreview` already
   * are (ruling 3): NOT in `SessionSnapshot`, so an undo neither restores nor
   * steals it, and not on `Session`, so `serializeSession*` never writes it —
   * the `.audm` byte-identity pins are unaffected by construction.
   *
   * Reconciled by the same subscriber that holds the K1 invariants above, and
   * for the same reason: the span is derived from clips that any mutation can
   * move, and a band drawn over a clip that has arrived under it would be a
   * lie the delete verbs would then act on.
   */
  selectedGap: TrackGap | null;
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
  /**
   * T5 — the live group-drag preview: what the members the pointer is NOT on
   * must draw while a group drag is in flight, and `null` whenever none is.
   *
   * UI-only state, never serialized and never in `SessionSnapshot` — nothing is
   * committed until the drop, so an undo has nothing to restore here. It lives
   * in the store rather than in `ClipView` for the one reason a component's own
   * state could not serve: the clip that must move is a DIFFERENT component
   * from the clip the pointer is on, and the two are siblings under a lane that
   * neither of them owns.
   *
   * `clipIds` EXCLUDES the grabbed clip, which previews itself through its own
   * `moveDx` exactly as it did before this field existed. That keeps the two
   * translates from ever being applied to the same element, so the render can
   * add them without a precedence rule.
   *
   * `deltaSample` is already through `clampGroupDelta` — the same call the drop
   * makes — so the preview shows what will be committed rather than what was
   * asked for.
   */
  groupDragPreview: { clipIds: string[]; deltaSample: number } | null;
  /**
   * Lot A (M4 / N11) — the `.audm` this project was opened from or last saved
   * to, or `null` for a project that has never been written. Plain Save writes
   * here without a dialog; Save As and Open Project set it; `newSession`, a
   * stem landing and a cover session reset it to `null`.
   *
   * Deliberately NOT on `Session`, so `serializeSession*` never writes it into
   * the file header, and NOT in `SessionSnapshot`, so an undo never restores
   * it — undoing past a Save As must not move where the next Save lands.
   */
  projectPath: string | null;
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
  moveClip(clipId: string, toTrackId: string, newStartSample: number, opts?: { clearOverlap?: boolean }): void; // clamps >=0; commits verbatim + maintains facing fades; opts.clearOverlap = v1.8 nudge; H1 no-op guard: same track + same RESOLVED sample records nothing
  trimClip(clipId: string, edge: 'start' | 'end', newBoundarySample: number): void; // adjusts offset/length, min 32; may overlap a neighbour; re-clamps fades (X2 — see setClipFade) and maintains facing fades on the overlap it reshapes (X5)
  /** D3 — RIGID TRANSLATION of a set of clips on ONE track by ONE delta, in ONE
   * `set()`: every named clip keeps its length, its offset, its gain AND both
   * fade fields verbatim, and only `startSample` moves. No `maintainFacingFades`
   * pass runs (the reason this action exists at all — see `closeGap`): a uniform
   * delta cannot change the geometry BETWEEN the movers, so there is no overlap
   * among them for the maintenance to re-read, and applying the same shift one
   * clip at a time WOULD invent one — the first mover leaves, which the second
   * mover's per-move snapshot reads as "this overlap is new", arming a crossfade
   * the gesture never asked for over a pair that was overlapping all along.
   *
   * Whatever geometry the movers form with the clips that STAY is committed
   * verbatim, the same way `moveClip` commits a requested position verbatim: a
   * translation that lands a mover on a stationary neighbour makes an honest raw
   * sum, not a synthesised crossfade (v1.9 ruling 10). `closeGap`'s only new
   * adjacency is a butt-join at the gap's start — width 0, which is not an
   * overlap and arms nothing either way.
   *
   * RIGID OR NOTHING (`moveClipsBy`'s rule): if any named clip would land before
   * sample 0 the whole call is a no-op, because a per-clip clamp would silently
   * deform the arrangement it was asked to carry across. A zero delta, an
   * unknown track and an empty/unmatched id set are no-ops too — same state
   * object back, so nothing is recorded. Array order is preserved in place
   * (`Track.clips` is insertion-ordered — trap T40). */
  translateClips(trackId: string, clipIds: readonly string[], deltaSample: number): void;
  /** Item 1 (M2/N1-N4) - splits one clip at `sample` (session samples, consumed
   * VERBATIM: the cursor was snapped, or deliberately not, when it was placed,
   * and this action never re-snaps or rounds it). The LEFT half keeps the
   * clip's id, documentId, gainDb and fadeIn(+curve); the RIGHT half is a fresh
   * `nextId('clip')` at `sample` keeping documentId, gainDb and
   * fadeOut(+curve), its `offsetSample` advanced by the left length converted
   * to the SOURCE rate (`opts.docRate`; a session-rate delta when absent or
   * equal) - the same `doc.sampleRate / sessionRate` conversion `readClipSlice`
   * applies when it reads the slice back (`mixdown.ts`). The seam gets no fade;
   * both halves pass through `reconcileTrimmedFades`.
   *
   * The clip is replaced IN PLACE in ONE `set()` and `maintainFacingFades` is
   * deliberately NOT run (N2): `isLegalSplitPoint` has already refused every
   * point inside or on the boundary of an overlap with a track-mate, so outside
   * those the two halves partition the span and each overlap pair's geometry is
   * carried unchanged by whichever half holds it. A remove+add split would
   * instead run `removeClip`'s maintenance and DISARM a crossfade partner's
   * facing fade, silently dropping the crossfade.
   *
   * No-op - same state object, nothing recorded - for an unknown id or an
   * illegal point. Returns the right half's id, or null for a no-op. */
  splitClip(clipId: string, sample: number, opts?: { docRate?: number }): string | null;
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
  /** Single-select: `id` becomes the primary AND the whole extended set (or
   * both are cleared for `null`). Unchanged for every caller that predates
   * K1 — a plain click still replaces the selection. */
  setSelectedClip(id: string | null): void;
  /** K1 — Ctrl+Click: adds `id` to the extended set and makes it the primary
   * (last clicked wins, so the single-target verbs follow the pointer), or
   * removes it when it was already a member. Removing the primary promotes
   * the last remaining member; removing the last member selects nothing. An
   * id no clip in the session carries is ignored — the set may never hold a
   * dangling reference. Records no undo entry: a selection is view state. */
  toggleSelectedClip(id: string): void;
  /** T5 — the whole selection, named at once (Ctrl+A's writer). Ids no clip
   * carries are dropped and duplicates collapse, so the set's "every member is
   * live" invariant holds by construction. The primary SURVIVES when the new
   * set still holds it and otherwise becomes the last member — Ctrl+A over a
   * standing selection must not move the Properties panel to another clip.
   * Records no undo entry: a selection is view state. */
  setSelectedClips(ids: readonly string[]): void;
  /** T5 — Shift+Click: adds every clip between the PRIMARY and `id` (by start
   * order, on the track they share) to the set, and makes `id` the primary.
   * Extends rather than replaces, so it composes with a Ctrl+Click set. Falls
   * back to a plain single select when there is no primary or when `id` is on
   * another track — a range across two timelines is not a range. An id no clip
   * carries is ignored. Records no undo entry: a selection is view state. */
  extendSelectionToClip(id: string): void;
  /** D3 — selects a gap (or clears it with `null`). Selecting one CLEARS the
   * clip selection: the multitrack shows one selection at a time, so the
   * Delete verbs never have to choose between two. The raw setter — the span
   * it is handed is committed verbatim, because the only production caller
   * resolved it through `gapAt` a moment earlier. Records no undo entry: a
   * selection is view state. */
  setSelectedGap(gap: TrackGap | null): void;
  /** F0 — opens/closes a track's envelope lane (see `mtEnvelope`). */
  setMtEnvelope(v: SessionState['mtEnvelope']): void;
  /** T5 — publishes (or clears, with `null`) the live group-drag preview. The
   * raw setter: the caller has already clamped, because it needed the clamped
   * number for its own translate too. */
  setGroupDragPreview(v: SessionState['groupDragPreview']): void;
  setMtCursor(s: number): void;
  setMtZoom(z: SessionState['mtZoom']): void;
  setMtPlayState(state: SessionState['mtPlayState']): void;
  setMtPlayheadSample(s: number): void;
  /** Lot A (M4): unrecorded — the path is not session content (see
   * `SessionState.projectPath`). Set by Save / Save As / Open Project, reset
   * to `null` by `newSession` and the load-shaped replacements. */
  setProjectPath(path: string | null): void;
  /** Lot A (N13): Save As renames the project to the file's basename. A
   * RECORDED mutation ('Rename project') because `session.name` lives on the
   * session object, and an unrecorded `session` replacement would break the
   * recording invariant in `sessionUndo.ts`. No-op when the name is unchanged
   * (same session reference, nothing recorded). */
  renameSession(name: string): void;
}

/** MT1-1 — the state a fresh session starts in, session and zoom together.
 * They cannot be written independently: the zoom IS a function of the session
 * (fit the longest track across the measured lane), and the constant
 * `{ samplesPerPixel: 512 }` that used to stand here was the reported bug —
 * 512 samples/px is 16 seconds of timeline whatever is on it, so a 2:58
 * session opened showing 18 seconds of itself. */
function freshSessionState(sampleRate: number): Pick<SessionState, 'session' | 'mtZoom'> {
  const session = makeSession(sampleRate);
  return { session, mtZoom: defaultSessionZoom(session) };
}

/** True when any track carries a clip — the predicate `addClip`'s re-fit arm
 * reads, and the one `menuActions`/`MultitrackView` state for their own gates. */
function hasAnyClip(session: Session): boolean {
  return session.tracks.some((t) => t.clips.length > 0);
}

/** K1 — every clip id the session currently holds. */
function liveClipIds(session: Session): Set<string> {
  const ids = new Set<string>();
  for (const t of session.tracks) for (const c of t.clips) ids.add(c.id);
  return ids;
}

/**
 * T5 — the ids a Shift+Click range covers: every clip on the track `anchorId`
 * and `targetId` SHARE, from one to the other inclusive, in START ORDER.
 *
 * Start order, not array order, because the range the user drew is the one
 * they can see: `track.clips` is insertion-ordered and a clip dropped into an
 * existing arrangement sits at the end of it. The sort is stable, so two clips
 * starting on the same sample keep their array order and the answer stays
 * deterministic.
 *
 * `null` when the two are not on one track (or either is not in the session) —
 * the caller's cue that this gesture is not a range at all. A range across two
 * timelines would have to invent a rule for what "between" means vertically,
 * and every clip that happened to lie in the rectangle is not what Shift+Click
 * means in a track-based editor.
 */
function clipRangeOnTrack(session: Session, anchorId: string, targetId: string): string[] | null {
  const track = session.tracks.find(
    (t) => t.clips.some((c) => c.id === anchorId) && t.clips.some((c) => c.id === targetId)
  );
  if (track === undefined) return null;
  const ordered = [...track.clips].sort((a, b) => a.startSample - b.startSample);
  const i = ordered.findIndex((c) => c.id === anchorId);
  const j = ordered.findIndex((c) => c.id === targetId);
  return ordered.slice(Math.min(i, j), Math.max(i, j) + 1).map((c) => c.id);
}

/**
 * K1 — THE selection invariant, re-established against a session (see
 * `SessionState.selectedClipIds`). One function because there is one rule, and
 * because the paths that can break it do not resemble each other: a clip
 * removal, a track removal, an undo/redo restore, a session load, `newSession`.
 * A per-action fixup would have to be written five times and would still miss
 * the sixth (undo restores a snapshot without running ANY of the actions).
 *
 * THE RULE IS "FOLLOW THE PRIMARY", and it is deliberately that narrow. The
 * primary is the field everything else already writes deliberately — it rides
 * the undo snapshot, every loader sets it, every selection action sets it — so
 * this derives the set from it and never the other way round: dead members drop
 * out, a live primary is put back into a set that lost it (exactly the state an
 * undo leaves, since the snapshot restores the primary and deliberately does
 * not restore the set), and a NULL primary means an empty set.
 *
 * That last clause is the one worth arguing, because the obvious alternative —
 * promote a surviving member when the primary's clip is removed — is a bug
 * waiting on a real code path. `.audm` files PERSIST clip ids (`sessionFile`
 * only bumps the id counter past them), so re-opening the session you were just
 * working in restores clips carrying the very ids the stale set still names.
 * A promoting reconcile would then override the loader's explicit
 * `selectedClipId: null` and hand back a selection nobody made. A reconcile
 * that only ever REMOVES references — plus the one growth the primary itself
 * authorises — cannot override anybody's deliberate write.
 *
 * The cost is stated plainly: removing the primary out of a multi-clip
 * selection clears the whole selection rather than leaving the rest of it
 * standing. In practice the group verbs remove every member anyway
 * (`removeClips`), so the case is reachable mainly through undo/redo landing on
 * a session that is missing the primary — where "nothing is selected" is a
 * perfectly honest answer.
 */
function reconcileSelection(
  session: Session,
  primary: string | null,
  ids: readonly string[]
): { selectedClipId: string | null; selectedClipIds: string[] } {
  const live = liveClipIds(session);
  if (primary === null || !live.has(primary)) {
    return { selectedClipId: null, selectedClipIds: [] };
  }
  const members = ids.filter((id) => live.has(id));
  if (!members.includes(primary)) members.push(primary);
  return { selectedClipId: primary, selectedClipIds: members };
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
 * `moveClip`/`trimClip`/`removeClip` edit has been applied to `tracks` (a draft
 * whose affected clips arrays are fresh copies), with `pre` snapshotted via
 * `preOverlapStates` before the edit — for `removeClip`, before the pivot
 * leaves the array, which is what lets the disarm loop clear the survivor's
 * now-stale facing fade (see that caller's own note). For each track-mate N of
 * the edited (pivot) clip:
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

/** N2 - whether `sample` is a legal split point for `clip` among its
 * track-mates `clips`: an INTEGER (every cursor writer rounds; nothing here
 * rounds or snaps - N1) at least 32 samples inside BOTH edges (`trimClip`'s
 * own minimum length), and not inside any raw overlap with a track-mate.
 *
 * The overlap interval is CLOSED at both ends: a split exactly at a mate's
 * start would mint an equal-start pair and one exactly at a mate's end an
 * equal-end pair, and `crossfadableOverlap` refuses both (rules 1 and 2), so
 * an armed crossfade there would silently degrade into two solo fades. Outside
 * every overlap the halves partition the clip's span and every pair's geometry
 * rides unchanged on whichever half holds it - which is exactly what lets
 * `splitClip` skip `maintainFacingFades`. */
function isLegalSplitPoint(clips: readonly Clip[], clip: Clip, sample: number): boolean {
  if (!Number.isInteger(sample)) return false;
  const end = clip.startSample + clip.lengthSample;
  if (sample - clip.startSample < 32 || end - sample < 32) return false;
  for (const m of clips) {
    if (m.id === clip.id || rawOverlapWidth(clip, m) === 0) continue;
    const lo = Math.max(clip.startSample, m.startSample);
    const hi = Math.min(end, m.startSample + m.lengthSample);
    if (sample >= lo && sample <= hi) return false;
  }
  return true;
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
  ...freshSessionState(44100),
  selectedClipId: null,
  selectedClipIds: [], // K1
  selectedGap: null, // D3
  mtCursorSample: 0,
  mtPlayState: 'stopped',
  mtPlayheadSample: 0,
  mtEnvelope: null,
  groupDragPreview: null, // T5
  projectPath: null, // lot A (M4)

  newSession(sampleRate) {
    // R3: recorded — File > New Session is a store mutation of the current
    // timeline (undo restores the discarded session), unlike the load-shaped
    // replacements (Open Project, stem landing) which CLEAR the history.
    recordSessionMutation('New session', () => {
      set({
        ...freshSessionState(sampleRate),
        selectedClipId: null,
        selectedClipIds: [], // K1
        selectedGap: null, // D3
        mtCursorSample: 0,
        mtPlayState: 'stopped',
        mtPlayheadSample: 0,
        mtEnvelope: null,
        // Lot A (M4 / N11): a new project has no file. Reset by the mutation,
        // but NOT in the snapshot — undoing this New Session restores the old
        // session and leaves the path `null`.
        projectPath: null,
      });
    });
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
    recordSessionMutation('Remove track', () => {
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
    });
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
    // MT1-1 — the ONE place the "did this insert change what Fit means?"
    // decision lives, so all three insert paths (Insert Active File in
    // `menuActions`, a Files-panel/OS drop in `laneDrop`, a punch-in take in
    // `multitrackRecord`) get it without stating it. Captured inside the set()
    // updater — the `removeTrack` pattern — because the answer is about the
    // state BEFORE the insert and there is no second lookup that can see it.
    //
    // WHY NOT ON EVERY INSERT. A user who has zoomed in to place a clip against
    // a beat must not have the timeline yanked back out from under them by the
    // next insert; a zoom the user chose outlives every later edit. Hence two
    // arms, and only two:
    //
    //  - `wasEmpty` — the session had no clips at all, so it had no length, so
    //    the zoom it is sitting at was fitted to the 60 s placeholder
    //    (`MT_EMPTY_TIMELINE_SEC`) rather than to anything the user can see.
    //    There is nothing to preserve. This is the reported case: open a file,
    //    Insert Active File, and the 2:58 track should be on screen whole.
    //  - `wasFitted` — the view is sitting exactly AT the fit, which is a state
    //    the user reaches only by never having zoomed or by pressing Fit; in
    //    both readings "keep everything visible" is what they asked for. It is
    //    the same arm `publishEditorLaneWidth` uses on a window resize, and it
    //    is what makes a MULTI-file drop work: `laneDrop` calls this once per
    //    file inside one gesture, so without it a 3-file drop would fit the
    //    first clip and leave the other two off the right edge.
    //
    // Anything else — the user zoomed, therefore chose — is left alone.
    let refit = false;
    recordSessionMutation('Add clip', () => {
      set((s) => {
        if (!s.session.tracks.some((t) => t.id === trackId)) return s; // R3 no-op guard
        refit =
          !hasAnyClip(s.session) ||
          s.mtZoom.samplesPerPixel >= fitSessionSamplesPerPixel(s.session);
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
    // Outside the recording bracket on purpose. mtZoom is deliberately absent
    // from `SessionSnapshot` (sessionUndo.ts, ruling 3) — undo restores what the
    // session WAS, not where the user was looking — and running the re-fit here
    // keeps that true by construction rather than by the snapshot's omission.
    if (refit) applySessionZoom({ samplesPerPixel: Number.POSITIVE_INFINITY, scrollSample: 0 });
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
        // H1: the R3 no-op guard `setClipFade` has stated since v1.9, arriving
        // here at last. A move to the track and sample the clip already holds
        // must cost nothing — no rebuilt session, so no `Move clip` entry
        // against UNDO_LIMIT and no `maintainFacingFades` pass re-arming or
        // reshaping a crossfade over a move that never happened. It is asked
        // AFTER the clamp and the overlap resolution, on the position that
        // would actually be committed, because a request the store resolves
        // back to where the clip already is is a no-op too.
        if (targetTrackIdx === loc.trackIdx && resolvedStart === clip.startSample) return s;
        const movedClip: Clip = { ...clip, startSample: resolvedStart };
        tracks[targetTrackIdx].clips = insertSorted(tracks[targetTrackIdx].clips, movedClip);

        maintainFacingFades(tracks, targetTrackIdx, loc.trackIdx, clipId, pre);
        return { session: { ...s.session, tracks } };
      });
    });
  },

  translateClips(trackId, clipIds, deltaSample) {
    recordSessionMutation('Move clips', () => {
      set((s) => {
        const trackIdx = s.session.tracks.findIndex((t) => t.id === trackId);
        if (trackIdx === -1 || deltaSample === 0) return s;
        const ids = new Set(clipIds);
        const movers = s.session.tracks[trackIdx].clips.filter((c) => ids.has(c.id));
        if (movers.length === 0) return s;
        // Rigid or nothing (moveClipsBy's rule): asked of every mover BEFORE
        // anything is written, because a per-clip clamp would deform the
        // arrangement this call was asked to carry across intact.
        if (movers.some((c) => c.startSample + deltaSample < 0)) return s;
        const tracks = s.session.tracks.map((t, i) =>
          i === trackIdx
            ? {
                ...t,
                // In place, not re-sorted: a uniform delta cannot reorder the
                // movers among themselves, and `Track.clips` is insertion-
                // ordered anyway (trap T40).
                clips: t.clips.map((c) =>
                  ids.has(c.id) ? { ...c, startSample: c.startSample + deltaSample } : c
                ),
              }
            : t // untouched tracks keep their object identity
        );
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

  splitClip(clipId, sample, opts) {
    let rightId: string | null = null;
    recordSessionMutation('Split clip', () => {
      set((s) => {
        const loc = findClipLocation(s.session.tracks, clipId);
        if (!loc) return s;
        const clips = s.session.tracks[loc.trackIdx].clips;
        const clip = clips[loc.clipIdx];
        if (!isLegalSplitPoint(clips, clip, sample)) return s;

        const leftLen = sample - clip.startSample;
        const rightLen = clip.startSample + clip.lengthSample - sample;
        // N3: the offset indexes the SOURCE document, at the DOCUMENT's rate -
        // `readClipSlice` (mixdown.ts) converts lengths by
        // `doc.sampleRate / sessionRate` with the same rounding, so the right
        // half of a mixed-rate clip must advance by the CONVERTED left length
        // or it reads the wrong source samples. `trimClip`'s own advance is
        // session-rate only (its edge moves in session samples on a clip whose
        // offset it re-derives) and is deliberately not copied here.
        const sessionRate = s.session.sampleRate;
        const docRate = opts?.docRate;
        const advance =
          docRate !== undefined && docRate !== sessionRate
            ? Math.round((leftLen * docRate) / sessionRate)
            : leftLen;

        const left = reconcileTrimmedFades(
          { ...clip, lengthSample: leftLen, fadeOutSample: undefined, fadeOutCurve: undefined },
          'end'
        );
        const right = reconcileTrimmedFades(
          {
            ...clip,
            id: nextId('clip'),
            startSample: sample,
            offsetSample: clip.offsetSample + advance,
            lengthSample: rightLen,
            fadeInSample: undefined,
            fadeInCurve: undefined,
          },
          'start'
        );
        rightId = right.id;

        // The left half is written at `clipIdx` (index-stable, exactly as
        // `trimClip` writes), the right half through `insertSorted`. The
        // track's `automation` rides the spread untouched: it is per-track and
        // timeline-keyed, so a clip split says nothing about it.
        const tracks = s.session.tracks.map((t, i) =>
          i === loc.trackIdx
            ? {
                ...t,
                clips: insertSorted(
                  t.clips.map((c, j) => (j === loc.clipIdx ? left : c)),
                  right
                ),
              }
            : t
        );
        return { session: { ...s.session, tracks } };
      });
    });
    return rightId;
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
    // K1: a single select IS the whole selection — the set follows the primary
    // rather than accumulating beside it.
    //
    // THE ASYMMETRY WITH `toggleSelectedClip`, named rather than closed.
    // The toggle refuses an id no clip carries (`liveClipIds` below) because
    // the group verbs read the set directly and a dangling member would be a
    // silent partial delete. This setter has no such check, so it can seat a
    // dangling id as both primary and sole member. That is an asymmetry, not a
    // live bug: no production caller can supply one — `TrackLane` passes null,
    // `ClipView` passes the clip it is rendering, `sessionInsert` the clip it
    // has just placed, `menuActions` null — and the set is defended twice
    // downstream anyway (`removeClips`/`moveClipsBy` skip unknown ids, and the
    // next session write runs `reconcileSelection`). Closing it here would be a
    // behaviour change rather than a tightening: this is the raw setter, and
    // `sessionStore.test.ts`'s "update state directly" pins that it writes the
    // id it is given against a session that holds no clips at all.
    set((s) => {
      // K1 no-op guard, in the spirit of the ones on the session writers above
      // and load-bearing for the same kind of reason rather than as an
      // optimisation. `TrackLane` calls this with `null` on EVERY press on
      // empty lane space; without the guard each of those presses would mint a
      // fresh `[]`, which is a new value for every clip's subscription to see
      // and therefore a repaint of the whole timeline for a click that changed
      // nothing. The comparison is over the WHOLE selection, not just the
      // primary — collapsing a multi-clip set down to its own primary is a
      // real change.
      const unchanged =
        s.selectedClipId === id &&
        s.selectedClipIds.length === (id === null ? 0 : 1) &&
        (id === null || s.selectedClipIds[0] === id) &&
        // D3: selecting a clip clears a selected gap, so a press that would
        // otherwise have been a no-op still has work to do while a band is up.
        // Clearing with `null` is NOT selecting a clip and leaves the gap
        // standing — `TrackLane` calls it on every press on empty lane space,
        // including the two presses that precede the double-click that selects
        // the gap in the first place.
        (id === null || s.selectedGap === null);
      if (unchanged) return s;
      return {
        selectedClipId: id,
        selectedClipIds: id === null ? [] : [id],
        ...(id === null ? null : { selectedGap: null }),
      };
    });
  },

  toggleSelectedClip(id) {
    // K1 (Ctrl+Click).
    set((s) => {
      if (s.selectedClipIds.includes(id)) {
        const selectedClipIds = s.selectedClipIds.filter((x) => x !== id);
        const selectedClipId =
          s.selectedClipId === id
            ? (selectedClipIds[selectedClipIds.length - 1] ?? null)
            : s.selectedClipId;
        return { selectedClipId, selectedClipIds };
      }
      // A set member must name a live clip: the group verbs act on this array
      // directly, and a dangling id would be a silent partial delete.
      if (!liveClipIds(s.session).has(id)) return s;
      // D3: one selection on screen at a time.
      return { selectedClipId: id, selectedClipIds: [...s.selectedClipIds, id], selectedGap: null };
    });
  },

  setSelectedClips(ids) {
    // T5 (Ctrl+A, and the writer any future "select these" gesture wants).
    set((s) => {
      // The liveness filter `toggleSelectedClip` applies one id at a time,
      // applied to the whole list for the same reason: the group verbs read
      // this array directly and a dangling member would be a silent partial
      // delete. De-duplication is part of the same guarantee — `removeClips`
      // would otherwise be handed the same clip twice.
      const live = liveClipIds(s.session);
      const seen = new Set<string>();
      const selectedClipIds: string[] = [];
      for (const id of ids) {
        if (!live.has(id) || seen.has(id)) continue;
        seen.add(id);
        selectedClipIds.push(id);
      }
      const selectedClipId =
        s.selectedClipId !== null && seen.has(s.selectedClipId)
          ? s.selectedClipId
          : (selectedClipIds[selectedClipIds.length - 1] ?? null);
      // The same no-op guard the two writers above carry, and load-bearing for
      // the same reason: Ctrl+A pressed twice must not mint a fresh array for
      // every clip's subscription to see.
      // D3: an EMPTY result is not a selection, so it leaves a standing gap
      // alone — the same asymmetry `setSelectedClip(null)` states above.
      const clearsGap = selectedClipIds.length > 0 && s.selectedGap !== null;
      const unchanged =
        selectedClipId === s.selectedClipId &&
        selectedClipIds.length === s.selectedClipIds.length &&
        selectedClipIds.every((id, i) => id === s.selectedClipIds[i]) &&
        !clearsGap;
      if (unchanged) return s;
      return { selectedClipId, selectedClipIds, ...(clearsGap ? { selectedGap: null } : null) };
    });
  },

  extendSelectionToClip(id) {
    // T5 (Shift+Click).
    set((s) => {
      if (!liveClipIds(s.session).has(id)) return s;
      const range =
        s.selectedClipId === null ? null : clipRangeOnTrack(s.session, s.selectedClipId, id);
      if (range === null) {
        // No primary to anchor to, or a target on another track: this gesture
        // is a plain click, and says so by behaving exactly like one. Stated
        // here rather than left to the caller so the rule has one home — the
        // docs promise "cross-track Shift+Click acts as a plain click", and
        // this is the line that keeps that promise.
        const unchanged =
          s.selectedClipId === id &&
          s.selectedClipIds.length === 1 &&
          s.selectedClipIds[0] === id &&
          s.selectedGap === null; // D3
        return unchanged ? s : { selectedClipId: id, selectedClipIds: [id], selectedGap: null };
      }
      // EXTENDS, so a set built with Ctrl+Click survives: the range is unioned
      // into the standing selection in the order it was drawn, and members
      // already present keep the position they had.
      const selectedClipIds = [...s.selectedClipIds];
      for (const rid of range) if (!selectedClipIds.includes(rid)) selectedClipIds.push(rid);
      const unchanged =
        s.selectedClipId === id &&
        selectedClipIds.length === s.selectedClipIds.length &&
        selectedClipIds.every((x, i) => x === s.selectedClipIds[i]) &&
        s.selectedGap === null; // D3
      return unchanged ? s : { selectedClipId: id, selectedClipIds, selectedGap: null };
    });
  },

  setSelectedGap(gap) {
    // D3 — the gap becomes THE selection: the clip selection goes with it, so
    // the two can never be up at once and Delete never has to pick. Clearing
    // (`null`) touches nothing else — Escape clears the band, it does not
    // un-select clips that were not selected anyway.
    set((s) => {
      const same =
        s.selectedGap !== null &&
        gap !== null &&
        s.selectedGap.trackId === gap.trackId &&
        s.selectedGap.startSample === gap.startSample &&
        s.selectedGap.endSample === gap.endSample;
      // The no-op guard the selection writers above carry, for the same reason:
      // re-selecting the same band must not mint a new object for every lane's
      // subscription to see.
      if (same || (gap === null && s.selectedGap === null)) return s;
      if (gap === null) return { selectedGap: null };
      // The clip fields are written only when there is something to clear — a
      // fresh `[]` over an already-empty set is a new value for every clip's
      // subscription to see, which is the repaint the K1 writers' own no-op
      // guards exist to avoid.
      return s.selectedClipId === null && s.selectedClipIds.length === 0
        ? { selectedGap: gap }
        : { selectedGap: gap, selectedClipId: null, selectedClipIds: [] };
    });
  },

  setMtEnvelope(v) {
    set({ mtEnvelope: v });
  },

  setGroupDragPreview(v) {
    // T5. The no-op guard the selection writers carry, in the one case that
    // recurs: `clearMovePreview` runs on every pointerup, including the ones
    // that end a click or a trim, and clearing what is already clear would
    // otherwise wake every store subscriber for a write that says nothing.
    // Deliberately NOT claimed as a repaint saving — the clips subscribe to a
    // NUMBER derived from this field (see `ClipView`), so `null` → `null`
    // leaves their selected value at 0 either way.
    set((s) => (s.groupDragPreview === null && v === null ? s : { groupDragPreview: v }));
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

  // ---- lot A (M4) ----
  setProjectPath(path) {
    set({ projectPath: path });
  },

  renameSession(name) {
    recordSessionMutation('Rename project', () => {
      set((s) => (s.session.name === name ? s : { session: { ...s.session, name } }));
    });
  },
  // ---- end lot A ----
}));

// ---------------------------------------------------------------------------
// MT1-1 — the session zoom's store-touching writers
// ---------------------------------------------------------------------------
/**
 * The ONE writer for every multitrack zoom gesture: resolve the request against
 * the live session, then commit it only if it actually differs. `setMtZoom`
 * stays the raw setter it always was (the `setZoom` split), so this is a
 * discipline about CALLERS, not a lock — grep `setMtZoom` before trusting it.
 *
 * The no-op guard is load-bearing rather than an optimisation: at the limit it
 * is what makes "nothing moves" observable, since a fresh but equal `mtZoom`
 * object would still be a new store snapshot and would repaint every lane, the
 * ruler, and the clip bitmaps for no reason.
 */
export function applySessionZoom(requested: SessionZoomRequest): void {
  const s = useSessionStore.getState();
  const next = resolveSessionZoom(s.session, requested);
  if (
    next.samplesPerPixel === s.mtZoom.samplesPerPixel &&
    next.scrollSample === s.mtZoom.scrollSample
  ) {
    return;
  }
  s.setMtZoom(next);
}

/**
 * MT2 — an EMPTY session takes the sample rate of the first document inserted
 * into it, and reports the ratio it moved by.
 *
 * THE REPORTED BUG. The session's rate was decided once, by
 * `makeSession(44100)` at store init, and nothing ever revisited it: two 48 kHz
 * files inserted into a session nobody had chosen a rate for were converted
 * — every sample, through the 64-tap sinc in `readClipSlice` — synchronously
 * inside `MultitrackPlayer.play()`. Measured on the packaged app with two 180 s
 * stereo clips: 22 039 ms to return from `play()` against 223 ms for the same
 * build and the same files with the session at 48 000 Hz.
 *
 * WHY "EMPTY" IS THE WHOLE CONDITION. A session's rate is the denominator of
 * every clip position, length and fade on its timeline, so changing it under
 * existing clips would mean rewriting all of them — and the second document is
 * a genuine mismatch anyway: two rates cannot both be native, and converting
 * one of them is the honest answer. But a session with NO clips denominates
 * nothing the user placed. 44 100 was a default, not a decision, so the first
 * document may as well name the rate — and then it lands at ratio 1 and the
 * resample never happens.
 *
 * WHAT ADOPTION MUST CARRY. Every session-sample number that exists at this
 * moment, because its next reader has no way to know it was left in the old
 * rate: the multitrack cursor, the live playhead, and the zoom — the last one
 * re-resolved through `resolveSessionZoom` (the ONE clamp) rather than written
 * raw, so the visible DURATION survives and the ceiling is re-applied against
 * the re-denominated timeline. There is no multitrack selection or loop range
 * to carry (only the cursor exists), and the snap targets are derived per
 * render from the session and the cursor (`sessionSnapTargets`), so they follow
 * for free.
 *
 * Returns `newRate / oldRate` — the factor a caller must apply to any session
 * sample it computed BEFORE calling (a drop position resolved against the lane's
 * old pixel mapping, say) — or 1 when nothing changed.
 *
 * Recorded, per the sessionUndo recording invariant. The insert paths call this
 * inside their own `withSessionGesture`, so the rate change and the clip it was
 * made for fold into ONE history entry and one Ctrl+Z lifts both.
 */
export function adoptSessionRate(docRate: number): number {
  const s = useSessionStore.getState();
  const from = s.session.sampleRate;
  if (!Number.isFinite(docRate) || docRate <= 0 || docRate === from) return 1;
  if (hasAnyClip(s.session)) return 1;

  const ratio = docRate / from;
  recordSessionMutation('Set session rate', () => {
    const session = { ...s.session, sampleRate: docRate };
    useSessionStore.setState({ session, ...viewStateAtRate(s, session, ratio) });
  });
  return ratio;
}

/**
 * MT2 (fix round 1) — THE re-denomination: the rate-denominated view state,
 * re-expressed for a session whose rate is about to become `session`'s.
 *
 * Extracted because it has TWO callers and they must not drift. Adoption moves
 * the denominator forward; a snapshot restore (undo, and redo) moves it back —
 * and the restore is where it was missing, which is the whole of the fix. Both
 * are the same act: the instant a number NAMES has to survive the change of the
 * unit it is counted in, because nothing downstream can tell which unit a bare
 * sample count was written in.
 *
 * The zoom goes through `resolveSessionZoom` rather than being written raw, so
 * the re-denominated `samplesPerPixel` is re-clamped against the session it is
 * about to describe — the one clamp, applied where the ceiling moved.
 *
 * `ratio` is `toRate / fromRate`, and `s` must be the state BEFORE the write.
 */
function viewStateAtRate(
  s: SessionState,
  session: Session,
  ratio: number
): Pick<SessionState, 'mtCursorSample' | 'mtPlayheadSample' | 'mtZoom'> {
  return {
    mtCursorSample: Math.round(s.mtCursorSample * ratio),
    mtPlayheadSample: Math.round(s.mtPlayheadSample * ratio),
    mtZoom: resolveSessionZoom(session, {
      samplesPerPixel: s.mtZoom.samplesPerPixel * ratio,
      scrollSample: Math.round(s.mtZoom.scrollSample * ratio),
    }),
  };
}

/**
 * MT1-1 — the multitrack lane reports how wide it actually is.
 *
 * Called from `MultitrackView`'s resize effect with the SCROLLER's width, which
 * is not the lane's: the 224 px track-header column lives inside every row, so
 * the subtraction happens here (`laneWidthFromScrollerWidth`) rather than in
 * the view, where it would be a number nothing tests.
 *
 * This is also the FIRST moment the real width is knowable, so like the
 * editor's twin it has two arms:
 *
 *  - a session that was sitting at the fit stays at the fit — a fitted view
 *    stays fitted across a window resize, the only reading of Fit that survives
 *    the user dragging the window edge;
 *  - anything zoomed in is merely re-resolved, which re-clamps the scroll to
 *    the new lane without throwing away where the user was looking.
 *
 * WHAT THIS IS NOT (MT1 fix round, I1). An earlier draft of this docblock also
 * called the first arm "the arm that re-fits a session opened from `.audm` or
 * from stem landing before any lane existed". It never did, and could not: those
 * paths committed a hardcoded 512 samples/px, which for anything longer than
 * about sixteen seconds is far zoomed IN of the fit, so `wasFitted` was false
 * and the arm was not taken. `measured` is module-global besides, so a SECOND
 * session opened in the same run finds the width unchanged and returns at the
 * guard without touching the zoom at all. Believing that sentence is what let
 * the reported bug survive the first pass: the load paths were left writing 512
 * because a rescue was assumed downstream. They now fit at the source (C1), and
 * this function is only what its two arms say.
 */
export function publishSessionLaneWidth(scrollerWidth: number): void {
  const previous = sessionLaneWidth();
  const laneWidth = laneWidthFromScrollerWidth(scrollerWidth);
  if (!setSessionLaneWidth(laneWidth)) return; // unchanged, or not a real measurement
  const s = useSessionStore.getState();
  const wasFitted = s.mtZoom.samplesPerPixel >= fitSessionSamplesPerPixel(s.session, previous);
  applySessionZoom(
    wasFitted ? { samplesPerPixel: Number.POSITIVE_INFINITY, scrollSample: 0 } : s.mtZoom
  );
}

/**
 * MT1 (I2) — a session that gets SHORTER re-resolves its zoom.
 *
 * `fit` is the zoom-out ceiling AND a function of the session's length, so any
 * mutation that shortens the timeline moves the ceiling down underneath a zoom
 * that was legal when it was committed. The result is precisely the state the
 * single-clamp design exists to make unreachable: measured at 44x past the fit
 * after deleting one long clip, with the readout at 34% on a surface whose user
 * guide says it never drops below 100%.
 *
 * Worse than cosmetic, because `addClip`'s "was this view fitted?" arm is
 * `spp >= fit`: a stale over-the-ceiling zoom reads as FITTED, so the next
 * insert re-fits and throws away a zoom the user deliberately chose — the one
 * thing that arm promises not to do.
 *
 * ONE subscription rather than a call at the end of each mutation, because the
 * shortening paths are `removeClip`, `removeTrack`, `trimClip` and `moveClip`
 * PLUS undo/redo restore — and undo restores a snapshot without running any of
 * the four, so a per-action call would have missed it. Watching the length is
 * also the honest statement of the rule: it is the length that moves the
 * ceiling, whatever moved the length.
 *
 * Only SHRINKING re-resolves. Growth is `addClip`'s business and it has its own
 * deliberate policy (fit on the first clip, respect a chosen zoom after that);
 * re-resolving on growth here would be a second, competing opinion. And
 * re-resolving is not re-fitting: `applySessionZoom` re-clamps only what is now
 * out of range, so a zoom that still fits is left exactly where the user put it.
 */
let lastTimelineLength = sessionTimelineLength(useSessionStore.getState().session);
useSessionStore.subscribe((s) => {
  const length = sessionTimelineLength(s.session);
  if (length === lastTimelineLength) return;
  const shrank = length < lastTimelineLength;
  lastTimelineLength = length;
  // The re-resolve below writes mtZoom, which re-enters this subscriber; the
  // length is unchanged by then, so it returns at the guard above.
  if (shrank) applySessionZoom(s.mtZoom);
});

// ---------------------------------------------------------------------------
// K1 — the GROUP verbs
// ---------------------------------------------------------------------------
/**
 * All three are module-level functions rather than store actions, exactly as
 * `adoptSessionRate` is, and all three are the same shape: a `withSessionGesture`
 * bracket around the store's OWN single-clip actions. That shape is the design,
 * not an implementation detail:
 *
 *  - ONE undo entry per gesture is the store's law (ruling 2), and a bracket is
 *    how this codebase already spells it (`Arm crossfade` writes two fades
 *    inside one).
 *  - Composing `removeClip`/`moveClip` means the overlap maintenance a group
 *    edit needs is the maintenance a drag already gets — `maintainFacingFades`,
 *    reached through the same door. A ripple shift that lands a clip on its
 *    neighbour arms the pair; a group move that dissolves a pair disarms it.
 *    There is no second opinion about overlaps anywhere in this file, which is
 *    what keeps K1 from re-opening the X4/X5 fade-maintenance surface.
 *  - The no-op guards inside those actions carry through unchanged: a member
 *    that would not move records nothing, so an empty gesture pushes no entry.
 *
 * Each resolves ids against the live session and silently skips ones no clip
 * carries (the selection is reconciled, but a caller may pass anything).
 */

/** Where a clip currently lives — `{trackId, clip}`, or null when the session
 * does not carry that id. */
function locateClip(session: Session, clipId: string): { trackId: string; clip: Clip } | null {
  for (const t of session.tracks) {
    const clip = t.clips.find((c) => c.id === clipId);
    if (clip) return { trackId: t.id, clip };
  }
  return null;
}

/** Deletes every clip in `clipIds`, in one undo entry. Single-member calls keep
 * the label a single delete has always had, so the History panel does not
 * suddenly read differently for the gesture that has not changed. */
export function removeClips(clipIds: readonly string[]): void {
  const state = useSessionStore.getState();
  const present = clipIds.filter((id) => locateClip(state.session, id) !== null);
  if (present.length === 0) return;
  withSessionGesture(present.length === 1 ? 'Remove clip' : 'Remove clips', () => {
    for (const id of present) useSessionStore.getState().removeClip(id);
  });
}

/** M2/N2 - the clips a split at `sample` would cut on `trackIds`: every clip on
 * those tracks for which `isLegalSplitPoint` holds. Pure, and shared by the
 * group verb below and by `edit.split`'s multitrack enablement, so the row
 * greys for exactly the cases the store would refuse.
 *
 * Two clips on ONE track can never both qualify - both containing `sample`
 * means they overlap there, which N2 excludes - so at most one clip per track
 * comes back. */
export function splitTargets(
  session: Session,
  trackIds: readonly string[],
  sample: number
): { trackId: string; clip: Clip }[] {
  const wanted = new Set(trackIds);
  const out: { trackId: string; clip: Clip }[] = [];
  for (const t of session.tracks) {
    if (!wanted.has(t.id)) continue;
    for (const c of t.clips) {
      if (isLegalSplitPoint(t.clips, c, sample)) out.push({ trackId: t.id, clip: c });
    }
  }
  return out;
}

/** Item 1 - splits every target of `splitTargets` in ONE undo entry ('Split
 * clip' / 'Split clips'), then, per N4, adds the right half of every original
 * that WAS a selection member to `selectedClipIds` (the primary is unchanged:
 * the left half keeps the id). The right half of an unselected track-mate - one
 * cut only because its track owns some other selected clip (M2) - stays
 * unselected, so the selection after the act still names what the user picked.
 *
 * `docRateOf` answers the source document's sample rate for a clip (N3); this
 * store holds document ids and never the documents, so the caller supplies it.
 * Returns the new right-half ids in track order, or `[]` - with no gesture at
 * all - when nothing qualifies. */
export function splitClipsAt(
  trackIds: readonly string[],
  sample: number,
  docRateOf?: (documentId: string) => number | undefined
): string[] {
  const targets = splitTargets(useSessionStore.getState().session, trackIds, sample);
  if (targets.length === 0) return [];
  const made: { leftId: string; rightId: string }[] = [];
  withSessionGesture(targets.length === 1 ? 'Split clip' : 'Split clips', () => {
    for (const { clip } of targets) {
      const rightId = useSessionStore
        .getState()
        .splitClip(clip.id, sample, { docRate: docRateOf?.(clip.documentId) });
      if (rightId !== null) made.push({ leftId: clip.id, rightId });
    }
  });
  const { selectedClipIds, setSelectedClips } = useSessionStore.getState();
  const member = new Set(selectedClipIds);
  const joining = made.filter((m) => member.has(m.leftId)).map((m) => m.rightId);
  if (joining.length > 0) setSelectedClips([...selectedClipIds, ...joining]);
  return made.map((m) => m.rightId);
}

/** The merged, ascending, non-overlapping union of the given spans. Ripple
 * delete measures the timeline it REMOVES, and two selected clips that overlap
 * each other remove their union once, not their lengths twice. */
function mergeSpans(spans: { start: number; end: number }[]): { start: number; end: number }[] {
  const sorted = [...spans].sort((a, b) => a.start - b.start);
  const merged: { start: number; end: number }[] = [];
  for (const s of sorted) {
    const last = merged[merged.length - 1];
    if (last !== undefined && s.start <= last.end) last.end = Math.max(last.end, s.end);
    else merged.push({ start: s.start, end: s.end });
  }
  return merged;
}

/**
 * K1 R3 — Ripple Delete: remove the named clips and close the gaps they leave.
 *
 * Per TRACK (a ripple is a statement about one timeline, and the other tracks
 * have their own): every surviving clip that lies entirely AFTER a removed span
 * shifts left by that span. "Entirely after" is `survivor.start >= removed.end`
 * — a survivor that OVERLAPS a removed clip is not later than it, it is beside
 * it, and shifting it would move a clip the user can see was not in the gap.
 *
 * The shift is applied through `moveClip`, one member at a time, LEFTMOST
 * FIRST: shifts are monotonic in start position, so processing left to right
 * means each clip moves into space that has already been vacated. A shift that
 * still lands on a neighbour (reachable when a removed clip overlapped a
 * survivor) is an overlap like any other and gets the drag's own facing-fade
 * maintenance — see the note on this section.
 */
export function rippleDeleteClips(clipIds: readonly string[]): void {
  const session = useSessionStore.getState().session;
  /** trackId -> the removed clips' spans on it. */
  const removedByTrack = new Map<string, { start: number; end: number }[]>();
  const present: string[] = [];
  for (const id of clipIds) {
    const found = locateClip(session, id);
    if (!found) continue;
    present.push(id);
    const spans = removedByTrack.get(found.trackId) ?? [];
    spans.push({
      start: found.clip.startSample,
      end: found.clip.startSample + found.clip.lengthSample,
    });
    removedByTrack.set(found.trackId, spans);
  }
  if (present.length === 0) return;

  // Resolved BEFORE anything is removed: the shifts describe the timeline the
  // user is looking at, and every survivor's target is fixed by that timeline
  // rather than by the intermediate states the removals pass through.
  const shifts: { clipId: string; trackId: string; toSample: number }[] = [];
  const removedIds = new Set(present);
  for (const track of session.tracks) {
    const spans = removedByTrack.get(track.id);
    if (spans === undefined) continue;
    const merged = mergeSpans(spans);
    for (const clip of track.clips) {
      if (removedIds.has(clip.id)) continue;
      let shift = 0;
      for (const span of merged) {
        if (span.end <= clip.startSample) shift += span.end - span.start;
      }
      if (shift > 0) {
        shifts.push({ clipId: clip.id, trackId: track.id, toSample: clip.startSample - shift });
      }
    }
  }
  shifts.sort((a, b) => a.toSample - b.toSample); // leftmost first

  withSessionGesture('Ripple delete', () => {
    for (const id of present) useSessionStore.getState().removeClip(id);
    for (const s of shifts) useSessionStore.getState().moveClip(s.clipId, s.trackId, s.toSample);
  });
}

/**
 * D3 — CLOSE A GAP: the localized ripple delete. Every clip on the gap's own
 * track that starts at or after the gap's end moves left by the gap's length,
 * in ONE undo entry. No other track moves, which is the whole request: the
 * silence the user pointed at goes, and the arrangement around it does not.
 *
 * The same shape as `rippleDeleteClips` above — the shifts are resolved against
 * the timeline the user is looking at, before anything moves — but NOT through
 * the same door: the whole set is carried by ONE `translateClips` write instead
 * of one `moveClip` per clip. There is deliberately no removal step either — a
 * gap is empty by definition, so closing it is the ripple's second half alone.
 *
 * ONE WRITE, BECAUSE PER-CLIP MOVES INVENT CROSSFADES (final review, C3).
 * `moveClip` runs `maintainFacingFades` on every commit against a snapshot taken
 * at that commit, so two movers that OVERLAP EACH OTHER are pulled apart by the
 * first move and re-joined by the second — and the second move's snapshot, which
 * cannot see that the pair was overlapping before the gesture started, reads
 * width 0 and arms a full-width crossfade over a legitimate raw sum (or over the
 * user's own partial facing fade, which it overwrites; clip mutations have no
 * undo of their own). Translating the whole set by one delta preserves the
 * movers' relative geometry exactly, so no pair among them is ever "new"; the
 * only new adjacency the close creates is the butt-join at the gap's start,
 * width 0 — not an overlap, and nothing to arm.
 *
 * STALE GAPS ARE A NO-OP WITH NO GESTURE. The selection is reconciled on every
 * session change, but a caller can hold a `TrackGap` across one (the Edit menu
 * reads the store, the smoke hooks build their own), and closing a span that
 * is no longer empty would shift clips over a gap that is not there. Re-asking
 * `gapAt` through the same probe the reconcile uses is the check; a mismatch
 * moves nothing and pushes no entry.
 */
export function closeGap(gap: TrackGap): void {
  const track = useSessionStore.getState().session.tracks.find((t) => t.id === gap.trackId);
  if (track === undefined) return;
  const live = gapAt(track, gapProbeSample(gap));
  if (live === null || live.startSample !== gap.startSample || live.endSample !== gap.endSample) {
    return;
  }
  const shifts = closeGapShifts(track, live);
  if (shifts.length === 0) return; // unreachable — a gap is bounded on its right by a clip
  withSessionGesture('Close gap', () => {
    useSessionStore.getState().translateClips(
      gap.trackId,
      shifts.map((s) => s.clipId),
      -(live.endSample - live.startSample)
    );
  });
  useSessionStore.getState().setSelectedGap(null);
}

/**
 * K1 R2 — the group drag: every member moves by the SAME delta, on its own
 * track, in one undo entry.
 *
 * The delta is clamped ONCE, against the earliest member, rather than each
 * member being clamped by `moveClip`'s own `>= 0`: clamping per member would
 * silently deform the group (the leading clip stops at zero while the rest keep
 * going), and a group drag that changes the spacing between the clips it is
 * dragging is not the gesture the user made. Rigid or nothing.
 *
 * Members are moved AWAY-EDGE FIRST — rightmost first when moving right,
 * leftmost first when moving left — so that no member ever passes THROUGH a
 * sibling that has not moved yet. The end state is the same either way, but the
 * intermediate states are not: `maintainFacingFades` runs per move, so a
 * transient collision between two clips that are travelling together would arm
 * a crossfade between them and then have to dissolve it, writing fades the
 * gesture never asked for.
 *
 * T5 — THE GROUP CROSSES TRACKS. `trackDelta` shifts every member by the same
 * number of LANES, which is the vertical statement of the same rigidity: the
 * relative offsets survive, so a group spanning two lanes still spans two
 * afterwards. It is all-or-nothing — a delta that would put any member off
 * either end of the track list moves nothing at all, rather than scattering the
 * members that happen to fit. `resolveGroupTrackDelta` is what the drag asks
 * before it commits; the refusal here is the last line of defence for a caller
 * that computed its own.
 *
 * This SUPERSEDES K1's "no member changes track" rule. The single-clip drag's
 * cross-lane move is untouched — it never went through this function.
 */
export function moveClipsBy(
  clipIds: readonly string[],
  deltaSample: number,
  trackDelta = 0
): void {
  const session = useSessionStore.getState().session;
  const members: { clipId: string; trackIdx: number; startSample: number }[] = [];
  for (const id of clipIds) {
    const trackIdx = session.tracks.findIndex((t) => t.clips.some((c) => c.id === id));
    if (trackIdx === -1) continue;
    const clip = session.tracks[trackIdx].clips.find((c) => c.id === id)!;
    members.push({ clipId: id, trackIdx, startSample: clip.startSample });
  }
  if (members.length === 0 || !Number.isFinite(deltaSample)) return;
  if (!Number.isInteger(trackDelta)) return;

  // T5: the clamp K1 computed here is `clampGroupDelta` now, so the live
  // preview can ask for the same answer before this runs. Same arithmetic,
  // one home — see that module's header for why it moved.
  const delta = clampGroupDelta(session, clipIds, deltaSample);
  // A purely VERTICAL drag is a real gesture: the early return is about the
  // horizontal delta alone, so it may only fire when there is no lane change
  // either.
  if (delta === 0 && trackDelta === 0) return;
  if (members.some((m) => m.trackIdx + trackDelta < 0 || m.trackIdx + trackDelta >= session.tracks.length))
    return;

  // AWAY-EDGE FIRST, now in both axes. Horizontally that is rightmost first
  // when moving right; VERTICALLY it is bottom-most first when moving down, so
  // that a member never lands in a lane a sibling has not left yet — the same
  // argument, since `maintainFacingFades` runs per move and a transient
  // collision between two clips travelling together would arm a crossfade the
  // gesture never asked for and then have to dissolve it. The lane is the
  // PRIMARY key when there is a lane change, because two members in the same
  // lane cannot collide with each other by changing lane together.
  const ordered = [...members].sort((a, b) => {
    if (trackDelta !== 0 && a.trackIdx !== b.trackIdx) {
      return trackDelta > 0 ? b.trackIdx - a.trackIdx : a.trackIdx - b.trackIdx;
    }
    return delta > 0 ? b.startSample - a.startSample : a.startSample - b.startSample;
  });
  withSessionGesture(ordered.length === 1 ? 'Move clip' : 'Move clips', () => {
    for (const m of ordered) {
      const targetTrackId = useSessionStore.getState().session.tracks[m.trackIdx + trackDelta].id;
      useSessionStore.getState().moveClip(m.clipId, targetTrackId, m.startSample + delta);
    }
  });
}

/**
 * K1 — the selection invariant, held by watching the SESSION rather than by
 * being restated in each action that could break it.
 *
 * Same shape and same argument as the I2 subscription above: the paths that
 * can strand a selection member are `removeClip`, `removeTrack`, `newSession`,
 * a `.audm` load, a stem/cover landing AND undo/redo restore — and the restore
 * runs none of the actions, so a per-action fixup would have missed exactly the
 * case the brief calls out. Watching the session is also the honest statement
 * of the rule: a member whose clip is gone is not a member, whatever removed
 * it.
 *
 * Gated on the session REFERENCE (the store is immutable, so that is the
 * cheapest possible test) and skipped entirely while nothing is selected,
 * which is the common case — a trim drag committing per pointermove must not
 * pay for a scan of every clip in the session on every event.
 *
 * The reconcile writes only the two selection fields, which does not change
 * the session reference, so the re-entry it causes returns at the guard.
 */
let lastReconciledSession = useSessionStore.getState().session;
useSessionStore.subscribe((s) => {
  if (s.session === lastReconciledSession) return;
  lastReconciledSession = s.session;
  // D3 — the GAP selection is reconciled here, by the same subscriber and for
  // the same argument: a gap is a span DERIVED from the clips beside it, so
  // every path that can strand a clip selection can also redraw a gap under
  // the band the user is looking at — a neighbour trimmed, a clip dropped into
  // the space, the track removed, an undo landing on another arrangement.
  //
  // Re-resolved through `gapAt` rather than compared field by field, so there
  // is one definition of "this is still a gap"; the probe is the midpoint,
  // which is strictly inside every span the resolver can name (see
  // `gapProbeSample`). Anything but the same span clears — a gap that merely
  // GREW is a different gap, and closing it would swallow silence the user
  // never selected.
  const gap = s.selectedGap;
  if (gap !== null) {
    const track = s.session.tracks.find((t) => t.id === gap.trackId);
    const live = track === undefined ? null : gapAt(track, gapProbeSample(gap));
    if (
      live === null ||
      live.startSample !== gap.startSample ||
      live.endSample !== gap.endSample
    ) {
      // Writes no session, so the re-entry this causes returns at the guard.
      useSessionStore.setState({ selectedGap: null });
    }
  }
  if (s.selectedClipId === null && s.selectedClipIds.length === 0) return;
  const next = reconcileSelection(s.session, s.selectedClipId, s.selectedClipIds);
  if (
    next.selectedClipId === s.selectedClipId &&
    next.selectedClipIds.length === s.selectedClipIds.length &&
    next.selectedClipIds.every((id, i) => id === s.selectedClipIds[i])
  ) {
    return; // nothing stranded — no new array, no repaint
  }
  useSessionStore.setState(next);
});

// R3 — binds the session undo plumbing to this store (one-way dependency:
// this module imports sessionUndo, never the reverse). The snapshot is
// `{ session, selectedClipId }` — see SessionSnapshot in sessionUndo.ts for
// the ruling-3 view-state pin.
//
// MT1 (I7): `apply` used to re-derive the F9 clip-bitmap purge here by diffing
// clip ids across the snapshot swap, because an undo does not re-run the
// mutation that would otherwise have purged. That whole discipline went with
// `clipWaveformCache` — there is no per-clip bitmap to strand any more, since
// `ClipView` draws the visible band straight to its on-screen canvas.
//
// MT2 (fix round 1): the ONE entry in this app that changes what a session
// sample MEANS is an insert that made an empty session adopt the document's
// rate. Restoring its snapshot put the rate back and left the cursor, the
// playhead and the zoom counted in the ADOPTED rate — a cursor placed at
// 2.000 s in a 44.1 kHz session read 4.35 s after Ctrl+Z of a 96 kHz insert,
// and a 15-second window silently became a 32.7-second one.
//
// This is NOT ruling 3 being repealed, and the distinction is the reason the
// conversion lives HERE rather than in `SessionSnapshot`. Ruling 3 forbids
// restoring REMEMBERED view state: an undo must not yank the viewport back to
// where it was, because that buys no comprehension. Nothing is remembered here
// — the snapshot still carries only `{session, selectedClipId}`. The live
// cursor is kept exactly where the user left it and merely re-counted, which is
// what "the undo did not touch the cursor" MEANS once the ruler underneath it
// has been re-scaled. Same-rate restores — every other entry in the app — take
// the `ratio === 1` arm and write nothing but the session and the selection,
// so `sessionStore.undo.test.ts`'s ruling-3 pin holds unchanged.
//
// The I2 shrink-subscription above is NOT this: it re-resolves a zoom whose
// CEILING moved, which after a rate revert happens to catch the illegal cases
// but never the merely mis-denominated ones (a stale samples/px under the new
// fit is legal and still shows the wrong number of seconds).
bindSessionUndo({
  capture: () => {
    const s = useSessionStore.getState();
    return { session: s.session, selectedClipId: s.selectedClipId };
  },
  apply: (snapshot) => {
    const s = useSessionStore.getState();
    const ratio = snapshot.session.sampleRate / s.session.sampleRate;
    const redenominate =
      Number.isFinite(ratio) && ratio > 0 && ratio !== 1
        ? viewStateAtRate(s, snapshot.session, ratio)
        : null;
    useSessionStore.setState({
      session: snapshot.session,
      selectedClipId: snapshot.selectedClipId,
      // D3 — this restore is a clip-selection writer too, so it owes the same
      // "one selection on screen at a time" clearing every other one does
      // (final review, C1). Without it an undo could put a clip selection back
      // UNDER a gap band standing on another track (the reconcile subscriber
      // deliberately keeps a gap whose own track did not change), leaving both
      // highlighted — and `edit.delete` reads the gap first, so Delete would
      // close the gap instead of removing the clip the user can see selected.
      // Only a NON-NULL restored selection clears it: an undo whose snapshot
      // carried no clip selection restores no selection either, and must leave
      // a standing gap exactly as it was (the ruling-3 pin).
      ...(snapshot.selectedClipId !== null ? { selectedGap: null } : null),
      ...redenominate,
    });
  },
});
