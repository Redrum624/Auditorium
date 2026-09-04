import type { AudioDocument } from '../audio/AudioDocument';
import { clipFadeGainAt, dbToLinear, readClipSlice, resolveClipFadeSpecs } from './mixdown';
import { createClip, type Clip, type Session, type Track } from './session';
import { useSessionStore } from './sessionStore';
import { withSessionGesture } from './sessionUndo';

/**
 * Merge Clips — the selected clips of one track become ONE clip spanning them,
 * with silence in the gaps and the audio baked into a new document.
 *
 * Three pieces, deliberately separate: `mergeTargets` decides WHAT merges (pure,
 * so the command's enablement asks the same question the verb answers),
 * `bakeMergedClip` renders the audio (pure, so it can be tested against the
 * offline mixdown sample for sample), and `commitMergedClips` writes the session
 * (the `splitClipsAt` shape — a `withSessionGesture` bracket around the store's
 * OWN actions, never a bespoke session mutation).
 *
 * The split between the last two is what keeps the session store's law intact:
 * this store never holds documents, so the caller mints the merged document from
 * `bakeMergedClip`'s output and hands `commitMergedClips` nothing but its id.
 */

export interface MergeTarget {
  trackId: string;
  /** >= 2 members, ascending startSample (ties keep track array order). */
  members: Clip[];
  startSample: number; // min member start
  lengthSample: number; // max member end - startSample
}

/**
 * D1 — the merges a selection asks for: `selectedClipIds` grouped by owning
 * track, one target per track holding TWO OR MORE of them (a track with a
 * single selected clip has nothing to merge with and is left alone). Pure. Ids
 * the session does not carry are skipped — the selection is reconciled, but a
 * caller may pass anything (`removeClips`' own rule).
 *
 * The span is `[min start, max end)` over the members, which is NOT the last
 * member's end: a member contained inside an earlier one must not shorten the
 * result. Unselected clips lying inside the span are not members and are left
 * exactly where they are — the merged clip simply overlaps them, which the
 * timeline has treated as first-class since v1.9 X5.
 */
export function mergeTargets(session: Session, selectedClipIds: readonly string[]): MergeTarget[] {
  const wanted = new Set(selectedClipIds);
  const targets: MergeTarget[] = [];
  for (const track of session.tracks) {
    // `filter` hands back a fresh array, so the sort below cannot reorder the
    // track's own clips (whose order is not an invariant anyway — trap T40).
    // Array#sort is stable, which is what makes equal starts keep track order.
    const members = track.clips.filter((c) => wanted.has(c.id));
    if (members.length < 2) continue;
    members.sort((a, b) => a.startSample - b.startSample);
    const startSample = members[0].startSample;
    let end = startSample;
    for (const m of members) end = Math.max(end, m.startSample + m.lengthSample);
    targets.push({ trackId: track.id, members, startSample, lengthSample: end - startSample });
  }
  return targets;
}

export interface MergedAudio {
  channels: Float32Array[];
  sampleRate: number;
}

/**
 * D3 — a mono member written into a STEREO merge goes into both channels at
 * this scale. The two pan laws disagree at centre: `monoPanGains(0)` puts a
 * centred mono clip at `cos(π/4) = 0.7071` per side while `stereoBalanceGains(0)`
 * puts a centred stereo clip at `1.0`. Baking the member as a stereo pair
 * switches the law that will apply to it afterwards, so the ratio between them
 * — `0.7071 / 1 = Math.SQRT1_2` — is exactly what preserves its level.
 */
const MONO_INTO_STEREO_GAIN = Math.SQRT1_2;

/**
 * D2/D3 — renders the members' contribution over the target span: the per-clip
 * math `mixdown.ts` already performs, and nothing else.
 *
 * Each member contributes `readClipSlice(doc, clip, sessionRate)` ×
 * `dbToLinear(clip.gainDb)` × `clipFadeGainAt(spec, i)`, summed with `+=`
 * (members may overlap) and never clamped — the merge is not a master bus.
 * `spec` comes from `resolveClipFadeSpecs(track.clips)`, resolved over the WHOLE
 * track rather than over the members alone, because that is the renderer's own
 * view: an armed crossfade between two members must bake AS the crossfade, and
 * the same resolver decides whether a member's solo fade has been superseded.
 *
 * Track volume, pan, mute, solo and automation are deliberately NOT baked: they
 * stay on the track and keep applying to the merged clip, so a merge does not
 * freeze a mix decision the user can still change.
 */
export function bakeMergedClip(
  track: Track,
  target: MergeTarget,
  docs: ReadonlyMap<string, AudioDocument>,
  sessionRate: number
): MergedAudio {
  // D3 — stereo as soon as ONE member's document has a second channel; a
  // document with more than two contributes channels 0 and 1, which is what the
  // mixdown reads. A member whose document is not open decides nothing here:
  // it contributes silence, and the span stands.
  const stereo = target.members.some((c) => (docs.get(c.documentId)?.channels.length ?? 0) >= 2);
  const channelCount = stereo ? 2 : 1;
  const channels: Float32Array[] = [];
  for (let c = 0; c < channelCount; c++) channels.push(new Float32Array(target.lengthSample));

  const specs = resolveClipFadeSpecs(track.clips);

  for (const clip of target.members) {
    const doc = docs.get(clip.documentId);
    if (!doc) continue;
    // MT2-3 — READ-ONLY, and may alias the document: only ever read from here.
    const slice = readClipSlice(doc, clip, sessionRate);
    if (slice.length === 0 || slice[0].length === 0) continue;

    const local = clip.startSample - target.startSample;
    const n = Math.min(slice[0].length, target.lengthSample - local);
    if (n <= 0) continue;
    const g = dbToLinear(clip.gainDb);
    const spec = specs.get(clip.id);

    if (stereo && slice.length === 1) {
      for (let i = 0; i < n; i++) {
        const v = slice[0][i] * g * (spec ? clipFadeGainAt(spec, i) : 1) * MONO_INTO_STEREO_GAIN;
        channels[0][local + i] += v;
        channels[1][local + i] += v;
      }
    } else {
      for (let c = 0; c < channelCount; c++) {
        const src = slice[c];
        const out = channels[c];
        for (let i = 0; i < n; i++) {
          out[local + i] += src[i] * g * (spec ? clipFadeGainAt(spec, i) : 1);
        }
      }
    }
  }

  return { channels, sampleRate: sessionRate };
}

function liveClipIds(session: Session): Set<string> {
  const ids = new Set<string>();
  for (const t of session.tracks) for (const c of t.clips) ids.add(c.id);
  return ids;
}

/** The track a clip currently sits on — `sessionStore`'s `locateClip` narrowed
 * to the half this module needs (that helper is module-private there). */
function trackIdOfClip(session: Session, clipId: string): string | null {
  for (const t of session.tracks) if (t.clips.some((c) => c.id === clipId)) return t.id;
  return null;
}

/**
 * D4/D5 — writes every entry in ONE undo entry and returns the merged clip ids
 * in track order (`[]`, with no gesture at all, when nothing qualifies).
 *
 * The bracket wraps the store's OWN `addClip`/`removeClip` — the K1 group-verb
 * shape — rather than a bespoke session write, so overlap maintenance comes for
 * free and has no second opinion: removing a member disarms an outsider's now
 * stale facing fade through `maintainFacingFades`, and `addClip` places the
 * merged clip verbatim without inventing any fade of its own. The merged clip
 * carries `gainDb: 0` and NO fade keys because both are inside the audio now.
 *
 * THE MERGED CLIP IS ADDED FIRST, THEN THE MEMBERS ARE REMOVED. Removing first
 * would leave the session TRANSIENTLY EMPTY whenever the merge takes every clip
 * in it, and `addClip` decides "did this insert change what Fit means?" from the
 * state it finds: an empty session takes its `wasEmpty` arm and re-fits, throwing
 * away a zoom the user chose — the exact yank that arm exists to avoid. Adding
 * first also never lengthens the timeline (the merged clip ends where the last
 * member does), so the shrink-watcher that re-resolves the zoom never fires
 * either. The maintenance semantics are unchanged by the order: the merged clip
 * carries no fade keys at all — `createClip` never sets one (D4) — so
 * `preOverlapStates` can never read a pair involving it as armed
 * (`(fade ?? 0) === width` fails for every `width > 0`). That covers the LAST
 * member too, whose end TIES the merged clip's own: `crossfadableOverlap`
 * rule 2 is strict (`aEnd > bEnd`), so a tie is not even excluded by geometry
 * — it is the missing fade keys, not the containment rule, that keeps that
 * pair inert. Which is why `removeClip`'s maintenance neither arms nor
 * disarms anything against the merged clip; an outsider armed against a
 * member is still disarmed by that member's own `removeClip`.
 *
 * Entries whose members are no longer all present are skipped: the targets were
 * resolved against a session that may have moved on (an undo between the resolve
 * and the commit), and a partial merge would silently delete the survivors.
 */
export function commitMergedClips(
  entries: readonly { target: MergeTarget; documentId: string }[]
): string[] {
  const before = useSessionStore.getState();
  const live = liveClipIds(before.session);
  const doable = entries.filter((e) => e.target.members.every((m) => live.has(m.id)));
  if (doable.length === 0) return [];

  // D5 — the primary's track, read BEFORE the gesture: `removeClip` clears
  // `selectedClipId` the moment the primary leaves the session, so afterwards
  // there is nothing left to ask.
  const primaryTrackId =
    before.selectedClipId === null ? null : trackIdOfClip(before.session, before.selectedClipId);

  const made: { trackId: string; clipId: string }[] = [];
  withSessionGesture('Merge clips', () => {
    for (const { target, documentId } of doable) {
      const merged = createClip({
        documentId,
        startSample: target.startSample,
        offsetSample: 0,
        lengthSample: target.lengthSample,
      });
      useSessionStore.getState().addClip(target.trackId, merged);
      for (const member of target.members) useSessionStore.getState().removeClip(member.id);
      made.push({ trackId: target.trackId, clipId: merged.id });
    }
  });

  const ids = made.map((m) => m.clipId);
  // D5 — `setSelectedClips` takes the LAST id as the primary when the old one
  // is gone, so the merge on the primary's own track is handed over last. With
  // no such merge the order is left alone, which makes the last merge in track
  // order the primary.
  const ordered = [...ids];
  const primaryIdx = made.findIndex((m) => m.trackId === primaryTrackId);
  if (primaryIdx >= 0) ordered.push(...ordered.splice(primaryIdx, 1));
  useSessionStore.getState().setSelectedClips(ordered);

  return ids;
}
