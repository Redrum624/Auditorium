import { nextId } from '../audio/AudioDocument';
import type { FadeCurve } from '../dsp/fades';

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

export interface Track {
  id: string; // 'track-N'
  name: string;
  volumeDb: number; // -60..+12, default 0
  pan: number; // -1 (L) .. 1 (R), default 0
  muted: boolean;
  solo: boolean;
  armed: boolean;
  clips: Clip[]; // sorted by startSample; MAY overlap — see the overlap contract on sessionStore's addClip
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
