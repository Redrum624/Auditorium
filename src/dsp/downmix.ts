/**
 * R6 — layout-aware surround-to-stereo downmix (ITU-R BS.775).
 *
 * THE LAW (Rec. ITU-R BS.775-3 (08/2012), Annex 4 "Downward mixing of
 * multichannel audio signals", Table 2, "Stereo – 2/0 format" row):
 *
 *   L' = 1.0000·L + 0.7071·C + 0.7071·Ls
 *   R' = 1.0000·R + 0.7071·C + 0.7071·Rs
 *
 * where 0.7071 is the Recommendation's printed value of 1/√2 (−3 dB); this
 * module uses the full-precision `Math.SQRT1_2`. Annex 8 lists 0.7071 first
 * among the alternative surround coefficients (0.7071 / 0.5 / 0), so the
 * Annex 4 value is also the default choice the Recommendation itself leads
 * with. Formats with fewer sources (3/0, 2/2, 2/1…) are the same table with
 * the absent channels simply not contributing — which is exactly how the
 * implementation degrades when C or the surround pair is missing.
 *
 * LFE IS DISCARDED — a decision, not an omission: the Annex 4 equations take
 * only L/R/C/Ls/Rs (the 3/2 format's five signals), §5 Fig. 9 is titled
 * "Down-mix of 5.1 surround sound to two-channel stereo typically discards
 * LFE channel" ("If it were included, it would likely overload the small
 * stereo speakers"), and §7 states "All content of the LFE channel is simply
 * discarded in this situation. The main channels must contain all the
 * essential programme elements". Folding LFE in at unity would double bass
 * that bass management already routes from the mains and risks overload.
 *
 * Overload handling: the raw 2/0 sum can reach 1 + 2·0.7071 ≈ 2.41. Output
 * is hard-clamped to ±1 — the SAME contract the app's existing fold law
 * (`downmixToStereo`) and the multitrack master bus apply, so the two laws
 * differ only in their matrix, never in their range behaviour.
 *
 * WHY THE MASK IS REQUIRED: BS.775 is a matrix over NAMED speakers. WAV
 * channel order is the dwChannelMask's set bits from lowest to highest, so
 * without a mask there is no honest way to know which index is C or LFE —
 * and a matrix keyed to a guessed layout misplaces content silently. Callers
 * must gate on {@link bs775Applicable} and fall back to the layout-agnostic
 * fold when it says no (see `downmixToStereoWithLaw`).
 *
 * Pure TS (no DOM, no Electron) per the dsp/ worker-safety rule.
 */

/** dwChannelMask speaker-position bits (WAVE_FORMAT_EXTENSIBLE, mmreg.h). */
export const SPEAKER_FRONT_LEFT = 0x1;
export const SPEAKER_FRONT_RIGHT = 0x2;
export const SPEAKER_FRONT_CENTER = 0x4;
export const SPEAKER_LOW_FREQUENCY = 0x8;
export const SPEAKER_BACK_LEFT = 0x10;
export const SPEAKER_BACK_RIGHT = 0x20;
export const SPEAKER_SIDE_LEFT = 0x200;
export const SPEAKER_SIDE_RIGHT = 0x400;

/**
 * The selectable stereo downmix law.
 *  - 'fold'  — the app's original layout-agnostic law (`downmixToStereo`):
 *              extras averaged and folded into both sides at −3 dB. The
 *              DEFAULT; byte-identical to pre-R6 output.
 *  - 'bs775' — the ITU-R BS.775-3 matrix above; requires a known layout.
 */
export type DownmixLaw = 'fold' | 'bs775';

/** −3 dB: BS.775-3 Annex 4 Table 2's printed 0.7071 at full precision. */
const BS775_GAIN = Math.SQRT1_2;

/** Number of set bits in a uint32 (SWAR popcount). */
function popcount32(v: number): number {
  v = v - ((v >>> 1) & 0x55555555);
  v = (v & 0x33333333) + ((v >>> 2) & 0x33333333);
  return (((v + (v >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
}

const clamp1 = (v: number): number => (v > 1 ? 1 : v < -1 ? -1 : v);

const ROLE_BITS =
  SPEAKER_FRONT_LEFT |
  SPEAKER_FRONT_RIGHT |
  SPEAKER_FRONT_CENTER |
  SPEAKER_LOW_FREQUENCY |
  SPEAKER_BACK_LEFT |
  SPEAKER_BACK_RIGHT |
  SPEAKER_SIDE_LEFT |
  SPEAKER_SIDE_RIGHT;

/**
 * True when `mask` names a layout the BS.775 2/0 matrix honestly covers:
 *
 *  - more than two channels (mono/stereo have nothing to fold);
 *  - the mask is present, nonzero, and its population count equals the
 *    channel count (every channel has exactly one named position — the same
 *    full-agreement rule `decodeWav` applies before carrying a mask at all);
 *  - every named position is one the matrix has a column for: FL FR FC LFE
 *    and ONE surround pair (back or side — real 5.1 writers use either bit
 *    pair for the Recommendation's Ls/Rs); both members of a pair present,
 *    never both pairs at once (a 3/4 layout such as 7.1 is NOT in Annex 4's
 *    table, so it falls back rather than pretending);
 *  - FL and FR both present (the matrix's unity terms).
 *
 * Everything else — 7.1, top/height speakers, BACK_CENTER, lone surrounds,
 * partial or contradictory masks — returns false, and the caller falls back
 * to the layout-agnostic fold: a crude law over a silently wrong one.
 */
export function bs775Applicable(mask: number | undefined, numChannels: number): boolean {
  if (mask === undefined || mask === 0 || numChannels <= 2) return false;
  if (popcount32(mask) !== numChannels) return false;
  if ((mask & ~ROLE_BITS) !== 0) return false;
  if (!(mask & SPEAKER_FRONT_LEFT) || !(mask & SPEAKER_FRONT_RIGHT)) return false;
  const hasBackLeft = (mask & SPEAKER_BACK_LEFT) !== 0;
  const hasBackRight = (mask & SPEAKER_BACK_RIGHT) !== 0;
  const hasSideLeft = (mask & SPEAKER_SIDE_LEFT) !== 0;
  const hasSideRight = (mask & SPEAKER_SIDE_RIGHT) !== 0;
  if (hasBackLeft !== hasBackRight || hasSideLeft !== hasSideRight) return false; // lone surround
  if (hasBackLeft && hasSideLeft) return false; // two surround pairs = 3/4-family, not in the 2/0 table
  return true;
}

/**
 * The BS.775-3 Annex 4 2/0 downmix over a mask-described channel set.
 * `channels` are in WAV order (mask bits, lowest first). Accumulation order
 * per output sample is fixed and documented: front + centre term + surround
 * term, then the ±1 clamp — tests replicate exactly this arithmetic.
 *
 * Throws when the layout is not applicable — callers select the law via
 * {@link downmixToStereoWithLaw} (decodeAudio.ts), which gates on
 * {@link bs775Applicable} and falls back to the fold instead of throwing.
 */
export function downmixBs775(channels: Float32Array[], mask: number): [Float32Array, Float32Array] {
  if (!bs775Applicable(mask, channels.length)) {
    throw new Error('BS.775 downmix requires a known, supported channel layout');
  }
  let fl = -1;
  let fr = -1;
  let fc = -1;
  let ls = -1;
  let rs = -1;
  let idx = 0;
  for (let bit = 0; bit < 32; bit++) {
    const b = 1 << bit;
    if (!(mask & b)) continue;
    if (b === SPEAKER_FRONT_LEFT) fl = idx;
    else if (b === SPEAKER_FRONT_RIGHT) fr = idx;
    else if (b === SPEAKER_FRONT_CENTER) fc = idx;
    else if (b === SPEAKER_BACK_LEFT || b === SPEAKER_SIDE_LEFT) ls = idx;
    else if (b === SPEAKER_BACK_RIGHT || b === SPEAKER_SIDE_RIGHT) rs = idx;
    // SPEAKER_LOW_FREQUENCY: discarded (see the module doc — BS.775-3 §5/§7).
    idx++;
  }

  const flCh = channels[fl];
  const frCh = channels[fr];
  const fcCh = fc >= 0 ? channels[fc] : null;
  const lsCh = ls >= 0 ? channels[ls] : null;
  const rsCh = rs >= 0 ? channels[rs] : null;

  const length = flCh.length;
  const L = new Float32Array(length);
  const R = new Float32Array(length);
  for (let i = 0; i < length; i++) {
    let l = flCh[i];
    let r = frCh[i];
    if (fcCh) {
      const c = BS775_GAIN * fcCh[i];
      l += c;
      r += c;
    }
    if (lsCh) l += BS775_GAIN * lsCh[i];
    if (rsCh) r += BS775_GAIN * rsCh[i];
    L[i] = clamp1(l);
    R[i] = clamp1(r);
  }
  return [L, R];
}
