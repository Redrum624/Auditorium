import type { AudioDocument } from '../audio/AudioDocument';
import { docLength } from '../audio/AudioDocument';
import { crossfadeGains, fadeInGainAt, fadeOutGainAt, type FadeCurve } from '../dsp/fades';
import { resampleChannel } from '../dsp/resample';
import type { Clip, Session, Track } from './session';
import { DEFAULT_FADE_CURVE, crossfadableOverlap } from './session';

/**
 * Offline stereo mixdown of a multitrack session — pure (no store imports),
 * deterministic, and the ground-truth render (the realtime MultitrackPlayer is
 * an approximation of this). The result is always a stereo pair.
 *
 * PAN LAW (asserted exactly by mixdown.test.ts):
 *
 *  - Mono source: constant-power. With pan p ∈ [-1, 1], θ = ((p+1)/2)·(π/2);
 *    gL = cos(θ), gR = sin(θ). At center (p=0) each side gets cos(π/4) ≈ 0.707,
 *    so a hard-panned mono source is +3 dB relative to a centered one (the
 *    standard constant-power law). The single channel feeds BOTH master sides.
 *
 *  - Stereo source: balance. gL = p<=0 ? 1 : cos(p·π/2);
 *    gR = p>=0 ? 1 : cos(-p·π/2). Unity on both sides at center; panning toward
 *    one side attenuates the OPPOSITE channel (leaving the near side untouched)
 *    rather than folding the channels together.
 *
 * Gains: clip.gainDb and track.volumeDb are independent linear multipliers
 * (10^(dB/20)) applied before panning. Solo/mute: if ANY track is soloed, only
 * soloed tracks are audible; a muted track is always silent (mute wins even on
 * a soloed track). Length = the maximum clip end (startSample + lengthSample)
 * over AUDIBLE tracks; an empty or all-silent session yields two empty channels.
 *
 * A clip whose source document rate differs from the session rate has its slice
 * resampled to the session rate (round positions). The master bus is HARD
 * clamped to ±1 after summing (a hard limiter, not soft-knee — documented v1
 * behavior; overlapping full-scale material simply flat-tops).
 */
export interface MixdownResult {
  channels: [Float32Array, Float32Array];
  sampleRate: number;
}

function dbToLinear(db: number): number {
  return Math.pow(10, db / 20);
}

/**
 * Constant-power mono pan law (see class PAN LAW note). Exported so the realtime
 * `MultitrackPlayer` builds its per-channel gain nodes from the SAME math the
 * offline mixdown uses — monitor and render then match exactly. `mixdownSession`
 * still calls it internally; the export is purely additive.
 */
export function monoPanGains(pan: number): { gL: number; gR: number } {
  const theta = ((pan + 1) / 2) * (Math.PI / 2);
  return { gL: Math.cos(theta), gR: Math.sin(theta) };
}

/**
 * Stereo balance pan law (see class PAN LAW note). Exported for the realtime
 * `MultitrackPlayer` (same rationale as {@link monoPanGains}); additive export.
 */
export function stereoBalanceGains(pan: number): { gL: number; gR: number } {
  const gL = pan <= 0 ? 1 : Math.cos((pan * Math.PI) / 2);
  const gR = pan >= 0 ? 1 : Math.cos((-pan * Math.PI) / 2);
  return { gL, gR };
}

function isAudible(track: Track, anySolo: boolean): boolean {
  return !track.muted && (!anySolo || track.solo);
}

function clamp1(v: number): number {
  return v > 1 ? 1 : v < -1 ? -1 : v;
}

/**
 * Reads the clip's source region as per-channel Float32Arrays at the SESSION
 * sample rate. `offsetSample`/`lengthSample` are interpreted so the clip
 * occupies exactly `lengthSample` samples on the session timeline: the number
 * of source samples read is `round(lengthSample · docRate / sessionRate)`
 * (== lengthSample when rates match), and those source samples are resampled up
 * to the session rate. Out-of-range source reads are zero-filled.
 *
 * Exported so the realtime MultitrackPlayer builds its AudioBuffers from the
 * exact same slice/resample logic the offline mixdown uses.
 */
export function readClipSlice(doc: AudioDocument, clip: Clip, sessionRate: number): Float32Array[] {
  const docSliceLen =
    doc.sampleRate === sessionRate
      ? clip.lengthSample
      : Math.round((clip.lengthSample * doc.sampleRate) / sessionRate);
  if (docSliceLen <= 0 || doc.channels.length === 0) return [];

  const srcLen = docLength(doc);
  const slices = doc.channels.map((ch) => {
    const out = new Float32Array(docSliceLen);
    for (let i = 0; i < docSliceLen; i++) {
      const idx = clip.offsetSample + i;
      out[i] = idx >= 0 && idx < srcLen ? ch[idx] : 0;
    }
    return out;
  });

  if (doc.sampleRate === sessionRate) return slices;
  return slices.map((ch) => resampleChannel(ch, doc.sampleRate, sessionRate));
}

/**
 * The correlation the multitrack crossfade hands to {@link crossfadeGains}.
 *
 * `0` is a DELIBERATE choice, not a missing feature: `rho` is a MEASURED
 * correlation in auto-remix (where an alignment search exists), and no
 * multitrack path measures anything. `fades.ts`'s contract for exactly this
 * case says a caller with no measurement must pass `rho = 0` -- the honest
 * assumption for two unrelated clips, normalising the pair for power
 * summation -- rather than invent an estimate.
 */
const CROSSFADE_RHO = 0;

/** One same-track overlap rendered as a crossfade. The SAME object is shared
 * by both members of the pair (outgoing reads `curveOut`/`gOut`, incoming
 * reads `curveIn`/`gIn`), so the two envelopes cannot disagree about the
 * region. `lengthSample` is the overlap width == both facing fade lengths. */
export interface ClipCrossfade {
  lengthSample: number;
  curveOut: FadeCurve;
  curveIn: FadeCurve;
}

/**
 * A clip's resolved render envelope: its solo fades (X2's fields with the
 * `?? 0` / `?? DEFAULT_FADE_CURVE` defaulting applied) plus, when the clip is
 * one side of a canonical same-track overlap, that edge's crossfade. A
 * superseded solo fade (the facing fade of a firing crossfade) is already
 * zeroed here, so consumers never have to ask "solo or crossfade?" per
 * sample -- the fields are mutually exclusive by construction.
 *
 * All positions are CLIP-LOCAL samples on the clip's own timeline span
 * (`[0, lengthSample)`, session rate). Consumers index by this `lengthSample`,
 * NEVER by a slice/buffer length: a rate-mismatched clip's resampled slice can
 * be a sample longer or shorter, and anchoring the fade-out to the slice tail
 * would put it on different samples in the two audio paths. Positions at or
 * past `lengthSample` (a resampled slice's overhang) evaluate to the fade's
 * endpoint gain via the shapes' internal clamp.
 */
export interface ClipFadeSpec {
  lengthSample: number;
  /** Solo fade-in length; 0 = none (or superseded by `crossIn`). */
  fadeIn: number;
  fadeInCurve: FadeCurve;
  /** Solo fade-out length; 0 = none (or superseded by `crossOut`). */
  fadeOut: number;
  fadeOutCurve: FadeCurve;
  /** Set when this clip is the INCOMING side of a crossfade, over its FIRST
   * `crossIn.lengthSample` samples. */
  crossIn: ClipCrossfade | null;
  /** Set when this clip is the OUTGOING side of a crossfade, over its LAST
   * `crossOut.lengthSample` samples. */
  crossOut: ClipCrossfade | null;
}

/**
 * Resolves one track's clips to their render envelopes. Returns a Map with an
 * entry ONLY for clips that need any shaping at all, so `specs.get(id)`
 * doubling as a has-envelope test keeps the fade-less render path untouched --
 * and byte-identical to v1.8.0 (ruling 10).
 *
 * WHEN AN OVERLAP BECOMES A CROSSFADE (the canonical-pair rule, X3's ruling):
 * a same-track overlap between A (earlier start) and B renders as a crossfade
 * exactly when
 *
 *   1. `A.start < B.start` and `B.start < A.end` -- a genuine overlap with an
 *      unambiguous outgoing side (equal starts have no handover direction);
 *   2. `A.end <= B.end` -- a handover, not containment. If A outlives B, A
 *      would have to jump from 0 back to full level at B's end: a click by
 *      construction, so containment stays a raw sum;
 *   3. `A.fadeOutSample === w` and `B.fadeInSample === w`, where
 *      `w = A.end - B.start` is the overlap width -- BOTH facing fades set,
 *      and spanning EXACTLY the overlap;
 *   4. no third clip on the track intersects the overlap region (T38: overlap
 *      pile-ups are constructible today; the pair law has no meaning for
 *      three simultaneous signals, so a pile-up stays a raw sum).
 *
 * Why exactly-`w` (rule 3) and not "any facing fades": the pair law is
 * continuous only when both ramps traverse their FULL `1 -> 0` / `0 -> 1`
 * range over ONE shared region. A facing fade shorter or longer than the
 * overlap ends its ramp mid-region at a non-extreme value, and the `1/k`
 * normalisation switching off there steps the gain audibly (derived, not
 * measured: an equal-power fade-in ending at the overlap midpoint steps from
 * `1/k` to 1 with `k = sqrt(3/2)` -- 1.76 dB). So partial
 * facing fades stay HONEST SOLO FADES over a raw sum -- still click-free,
 * because every solo envelope is itself continuous -- and only the exact
 * pairing X5's gesture maintains (both facing fades == the overlap) engages
 * the law. Ruling 10 falls out of rule 3 for free: a pre-v1.9 session has no
 * fade fields, fails `0 === w`, and keeps v1.8.0's raw-sum-then-clamp audio
 * byte-for-byte.
 *
 * In the canonical case the crossfade IS the two facing solo fades -- their
 * windows coincide with the overlap -- with the pair normalised by X1's `k`.
 * The solo fields are zeroed on both members (superseded, never
 * double-applied) and each member gets the shared {@link ClipCrossfade}.
 *
 * At most one crossfade can exist per clip edge: a second candidate at the
 * same edge would itself intersect the first pair's region and trip rule 4
 * for both pairs. The X2 clamp (`fadeIn + fadeOut <= lengthSample`) likewise
 * guarantees a clip's remaining solo fade cannot reach into its crossfade
 * region: `fadeOut === w` bounds `fadeIn <= length - w`, whose window ends at
 * or before the overlap starts. So the regions of one spec never overlap.
 *
 * Order-independent: pairs are compared by `startSample`, not array position,
 * because the sorted invariant does not actually hold (`trimClip('start')`
 * writes in place without re-sorting).
 */
export function resolveClipFadeSpecs(clips: readonly Clip[]): Map<string, ClipFadeSpec> {
  const crossIns = new Map<string, ClipCrossfade>();
  const crossOuts = new Map<string, ClipCrossfade>();

  for (let i = 0; i < clips.length; i++) {
    for (let j = i + 1; j < clips.length; j++) {
      // Rules 1, 2 and 4 live in the shared geometry predicate (session.ts)
      // since X5, so the renderer's gate and the store's gesture-side arming
      // cannot drift apart. Rule 3 — the facing-fade match — stays here: it is
      // the renderer's half of the contract.
      const geo = crossfadableOverlap(clips, clips[i], clips[j]);
      if (!geo) continue; // rules 1/2/4
      const { a, b, width: w } = geo;
      if ((a.fadeOutSample ?? 0) !== w || (b.fadeInSample ?? 0) !== w) continue; // rule 3
      const cross: ClipCrossfade = {
        lengthSample: w,
        curveOut: a.fadeOutCurve ?? DEFAULT_FADE_CURVE,
        curveIn: b.fadeInCurve ?? DEFAULT_FADE_CURVE,
      };
      crossOuts.set(a.id, cross);
      crossIns.set(b.id, cross);
    }
  }

  const specs = new Map<string, ClipFadeSpec>();
  for (const c of clips) {
    const crossIn = crossIns.get(c.id) ?? null;
    const crossOut = crossOuts.get(c.id) ?? null;
    const fadeIn = crossIn ? 0 : (c.fadeInSample ?? 0); // superseded when crossfaded
    const fadeOut = crossOut ? 0 : (c.fadeOutSample ?? 0);
    if (fadeIn <= 0 && fadeOut <= 0 && !crossIn && !crossOut) continue;
    specs.set(c.id, {
      lengthSample: c.lengthSample,
      fadeIn,
      fadeInCurve: c.fadeInCurve ?? DEFAULT_FADE_CURVE,
      fadeOut,
      fadeOutCurve: c.fadeOutCurve ?? DEFAULT_FADE_CURVE,
      crossIn,
      crossOut,
    });
  }
  return specs;
}

/**
 * The clip's envelope gain at clip-local sample `i` -- THE per-sample fade
 * expression, shared verbatim by the offline mixdown and the realtime
 * player's buffer bake so the two paths cannot drift (ruling 4). Solo fades
 * come from the curve family directly (`fadeInGainAt`/`fadeOutGainAt`, ruling
 * 8: a solo fade is NOT a half crossfade); a crossfade edge comes from
 * `crossfadeGains` at `rho = 0` with the pair's two facing curves, taking
 * `gOut` on the outgoing side and `gIn` on the incoming side of the SAME
 * call, so the pair sums level-preservingly by X1's `k` identity.
 *
 * `t = i / (w - 1)` matches the solo helpers' endpoint-inclusive ramp
 * convention: the first crossfade sample is exactly `{gOut: 1, gIn: 0}` and
 * the last exactly `{gOut: ~0, gIn: 1}`, which is what makes the region
 * continuous with the un-faded audio on both sides. A one-sample crossfade
 * has no ramp to index, so it takes the midpoint `t = 0.5` (both sides
 * sounding at equal, `k`-normalised level for that single shared sample).
 *
 * The spec's regions are mutually disjoint (see `resolveClipFadeSpecs`), so
 * at most one factor below differs from 1 -- the multiplies compose rather
 * than guard against each other.
 */
export function clipFadeGainAt(spec: ClipFadeSpec, i: number): number {
  let g = 1;
  if (i < spec.fadeIn) {
    g *= fadeInGainAt(i, spec.fadeIn, spec.fadeInCurve);
  }
  if (spec.fadeOut > 0 && i >= spec.lengthSample - spec.fadeOut) {
    g *= fadeOutGainAt(i - (spec.lengthSample - spec.fadeOut), spec.fadeOut, spec.fadeOutCurve);
  }
  if (spec.crossIn && i < spec.crossIn.lengthSample) {
    const w = spec.crossIn.lengthSample;
    g *= crossfadeGains(w > 1 ? i / (w - 1) : 0.5, CROSSFADE_RHO, spec.crossIn.curveOut, spec.crossIn.curveIn).gIn;
  }
  if (spec.crossOut) {
    const w = spec.crossOut.lengthSample;
    const start = spec.lengthSample - w;
    if (i >= start) {
      g *= crossfadeGains(w > 1 ? (i - start) / (w - 1) : 0.5, CROSSFADE_RHO, spec.crossOut.curveOut, spec.crossOut.curveIn).gOut;
    }
  }
  return g;
}

export function mixdownSession(
  session: Session,
  docs: Map<string, AudioDocument>,
  onProgress?: (fraction: number) => void
): MixdownResult {
  const sr = session.sampleRate;
  const anySolo = session.tracks.some((t) => t.solo);
  const audible = session.tracks.filter((t) => isAudible(t, anySolo));

  let length = 0;
  for (const t of audible) {
    for (const c of t.clips) {
      length = Math.max(length, c.startSample + c.lengthSample);
    }
  }

  if (length === 0) {
    onProgress?.(1);
    return { channels: [new Float32Array(0), new Float32Array(0)], sampleRate: sr };
  }

  const L = new Float32Array(length);
  const R = new Float32Array(length);

  const total = audible.length;
  let done = 0;
  for (const t of audible) {
    const trackGain = dbToLinear(t.volumeDb);
    // Same-track fades/crossfades, resolved once per track. The spec lookup
    // doubles as the has-envelope test: a fade-less clip takes the plain loop
    // below UNCHANGED, so a session without fade fields renders byte-identical
    // to v1.8.0 (ruling 10).
    const fadeSpecs = resolveClipFadeSpecs(t.clips);
    for (const c of t.clips) {
      const doc = docs.get(c.documentId);
      if (!doc) continue;
      const slice = readClipSlice(doc, c, sr);
      if (slice.length === 0 || slice[0].length === 0) continue;

      const g = dbToLinear(c.gainDb) * trackGain;
      const mono = slice.length === 1;
      const { gL, gR } = mono ? monoPanGains(t.pan) : stereoBalanceGains(t.pan);
      const chL = slice[0];
      const chR = mono ? slice[0] : slice[1];

      const base = c.startSample;
      const n = Math.min(slice[0].length, length - base);
      const spec = fadeSpecs.get(c.id);
      if (spec) {
        // Envelope applied PER CLIP, before the `+=` accumulation -- never to
        // the summed bus, and never after the clamp pass below (T22): two
        // crossfading clips must each be shaped before they meet, and the
        // clamp must see the already-shaped (lower) peaks.
        for (let i = 0; i < n; i++) {
          const e = clipFadeGainAt(spec, i);
          L[base + i] += chL[i] * g * gL * e;
          R[base + i] += chR[i] * g * gR * e;
        }
      } else {
        for (let i = 0; i < n; i++) {
          L[base + i] += chL[i] * g * gL;
          R[base + i] += chR[i] * g * gR;
        }
      }
    }
    done++;
    onProgress?.(done / total);
  }

  for (let i = 0; i < length; i++) {
    L[i] = clamp1(L[i]);
    R[i] = clamp1(R[i]);
  }

  onProgress?.(1);
  return { channels: [L, R], sampleRate: sr };
}
