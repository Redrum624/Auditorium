import { docLength, nextId, type AudioDocument } from '../audio/AudioDocument';
import type { FadeCurve } from '../dsp/fades';
import type { AutomationLane } from './automation';

export interface Clip {
  id: string; // 'clip-N'
  documentId: string; // source AudioDocument id
  startSample: number; // position on session timeline (in session sampleRate)
  offsetSample: number; // start offset into the source document
  lengthSample: number; // number of samples taken from the source document
  gainDb: number;
  /** Non-destructive edge fades (v1.9 X2). All four keys are OPTIONAL, and
   * absent (or `undefined`) means "no fade" / "default curve" — this is what
   * keeps a session that never touched fades byte-identical on disk to what
   * v1.8.0 wrote (`JSON.stringify` drops absent AND `undefined`-valued keys),
   * and what lets every pre-fade `.audm` load unchanged. Readers use
   * `?? 0` / `?? DEFAULT_FADE_CURVE`; nothing may distinguish `undefined`
   * from a missing key.
   *
   * Units: samples at the SESSION rate, measured over the clip's own timeline
   * span (`lengthSample`) — `fadeInSample` from the clip's start edge,
   * `fadeOutSample` back from its end edge.
   *
   * Invariant (established by `sessionStore.setClipFade`, re-established by
   * `trimClip` after a shortening trim, and enforced against foreign/corrupt
   * files at parse time in `sessionFile.ts`): when present, each is a positive
   * integer and `fadeInSample + fadeOutSample <= lengthSample` (the two fades
   * may meet, never cross). Consumers (X3 mixdown/player, X4 UI) index by
   * these values directly and do not re-clamp. */
  fadeInSample?: number;
  fadeOutSample?: number;
  fadeInCurve?: FadeCurve;
  fadeOutCurve?: FadeCurve;
}

/** The curve an absent `fadeInCurve`/`fadeOutCurve` means. `'equal-power'` is
 * `FADE_CURVES[0]`, documented in `dsp/fades.ts` as "the safe default" (holds
 * the level on unrelated material — the normal case for a solo clip fade). */
export const DEFAULT_FADE_CURVE: FadeCurve = 'equal-power';

/** Clamps a fade pair to the Clip fade invariant: each fade in
 * `[0, lengthSample]` and `fadeIn + fadeOut <= lengthSample` (fades may meet
 * exactly, never cross). `priority` names the side that is PRESERVED when the
 * two would cross — it is clamped only by the clip length, and the other side
 * gets whatever room remains. Inputs must be finite numbers (callers own
 * type/NaN guarding and any rounding); outputs may be 0, which callers
 * normalize back to `undefined` ("no fade") before storing on a Clip. */
export function clampFadePair(
  fadeIn: number,
  fadeOut: number,
  lengthSample: number,
  priority: 'in' | 'out'
): { fadeIn: number; fadeOut: number } {
  const len = Math.max(0, lengthSample);
  if (priority === 'in') {
    const fi = Math.min(Math.max(0, fadeIn), len);
    return { fadeIn: fi, fadeOut: Math.min(Math.max(0, fadeOut), len - fi) };
  }
  const fo = Math.min(Math.max(0, fadeOut), len);
  return { fadeIn: Math.min(Math.max(0, fadeIn), len - fo), fadeOut: fo };
}

/** The crossfade-capable overlap GEOMETRY between two clips of one track —
 * rules 1, 2 and 4 of the canonical-pair rule (X3's ruling; rule 3, the
 * facing-fade match, is the caller's half: the renderer CHECKS it in
 * `resolveClipFadeSpecs`, and the store's gesture maintenance ESTABLISHES it
 * — see `sessionStore`'s overlap contract). Returns the oriented pair — `a`
 * outgoing (earlier start), `b` incoming — and the overlap width
 * `a.end − b.start`, or `null` when the pair cannot crossfade regardless of
 * what fades are set:
 *  - no overlap, or equal starts (rule 1 — no handover direction);
 *  - containment, `a` outliving `b` (rule 2 — `a` would have to jump from 0
 *    back to full level at `b`'s end: a click by construction);
 *  - a third clip of `clips` intersecting the overlap region (rule 4 — the
 *    pair law has no meaning for three simultaneous signals).
 * Order-independent: the pair is oriented by `startSample`, never by array
 * position, because the sorted invariant does not actually hold
 * (`trimClip('start')` writes in place without re-sorting). `x` and `y` must
 * be elements of `clips` — the intrusion scan excludes them by identity. */
export function crossfadableOverlap(
  clips: readonly Clip[],
  x: Clip,
  y: Clip
): { a: Clip; b: Clip; width: number } | null {
  if (x.startSample === y.startSample) return null; // rule 1: no outgoing side
  const a = x.startSample < y.startSample ? x : y;
  const b = a === x ? y : x;
  const aEnd = a.startSample + a.lengthSample;
  const bEnd = b.startSample + b.lengthSample;
  if (b.startSample >= aEnd) return null; // rule 1: no overlap
  if (aEnd > bEnd) return null; // rule 2: containment
  const intruded = clips.some(
    (c) => c !== a && c !== b && c.startSample < aEnd && c.startSample + c.lengthSample > b.startSample
  );
  if (intruded) return null; // rule 4
  return { a, b, width: aEnd - b.startSample };
}

export interface Track {
  id: string; // 'track-N'
  name: string;
  volumeDb: number; // -60..+12, default 0
  pan: number; // -1 (L) .. 1 (R), default 0
  muted: boolean;
  solo: boolean;
  armed: boolean;
  /** Kept in startSample order by `insertSorted` (addClip/moveClip), but
   * `trimClip('start')` writes in place without re-sorting, so the order is
   * NOT an invariant consumers may assume (trap T40). Clips MAY overlap —
   * see the overlap contract on sessionStore's `addClip`. */
  clips: Clip[];
  /** F0 (v1.10) automation lanes — OPTIONAL, and ABSENT means none. Never
   * initialised by `createTrack`, removed entirely when the last lane empties
   * (see `sessionStore.removeAutomationKey`), and never written to disk when
   * absent — which is what keeps a session that never touched automation
   * byte-identical to what v1.9.2 wrote (the byte-identity pin in
   * `sessionFile.test.ts` hard-codes the v1.8.0 track key order; when the
   * store DOES write this field, the object spread appends it after `clips`).
   * Semantics, invariants and the shared evaluator live in `automation.ts`;
   * an active lane OVERRIDES this track's static field (ruling B). */
  automation?: AutomationLane[];
}

export interface Session {
  name: string;
  sampleRate: number;
  tracks: Track[];
}

/** Creates a fresh, empty track with default params (`volumeDb: 0, pan: 0`,
 * all flags false) and a sequential 'track-N' id. */
export function createTrack(name: string): Track {
  return {
    id: nextId('track'),
    name,
    volumeDb: 0,
    pan: 0,
    muted: false,
    solo: false,
    armed: false,
    clips: [],
  };
}

/**
 * How many SESSION samples a whole document occupies when placed as a clip.
 *
 * The conversion every placement needs — Insert Active File, and (F11-4) a
 * drop from the Files panel or from Explorer. It lives here, once, because a
 * clip's `lengthSample` is stated in session samples while a document's length
 * is stated in its own, and two placements disagreeing about that would put
 * the same file on the timeline at two different lengths.
 */
export function documentClipLength(doc: AudioDocument, sessionRate: number): number {
  const srcLen = docLength(doc);
  return doc.sampleRate === sessionRate
    ? srcLen
    : Math.round((srcLen * sessionRate) / doc.sampleRate);
}

/** Creates a clip referencing a region of a source AudioDocument, with a
 * sequential 'clip-N' id. `gainDb` defaults to 0 when omitted. */
export function createClip(opts: {
  documentId: string;
  startSample: number;
  offsetSample: number;
  lengthSample: number;
  gainDb?: number;
}): Clip {
  return {
    id: nextId('clip'),
    documentId: opts.documentId,
    startSample: opts.startSample,
    offsetSample: opts.offsetSample,
    lengthSample: opts.lengthSample,
    gainDb: opts.gainDb ?? 0,
  };
}

/** The source-document window a clip reads, in the DOCUMENT's own samples:
 * `[offsetSample, offsetSample + span)` where `span` is `lengthSample`
 * session samples converted at `docRate / sessionRate` — `readClipSlice`'s
 * own conversion (mixdown.ts), kept identical on purpose. UNCLAMPED: a clip
 * trimmed past its source yields an end beyond `docLength`; clamp through
 * `resolveRegion` (services/selectionRegion.ts) when a view needs real
 * sample positions. */
export function clipSourceWindow(
  clip: Pick<Clip, 'offsetSample' | 'lengthSample'>,
  docRate: number,
  sessionRate: number
): { start: number; end: number } {
  const span =
    docRate === sessionRate
      ? clip.lengthSample
      : Math.round((clip.lengthSample * docRate) / sessionRate);
  return { start: clip.offsetSample, end: clip.offsetSample + span };
}
