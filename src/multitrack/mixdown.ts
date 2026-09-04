import type { AudioDocument } from '../audio/AudioDocument';
import { docLength } from '../audio/AudioDocument';
import { crossfadeGains, fadeInGainAt, fadeOutGainAt, type FadeCurve } from '../dsp/fades';
import { resampleChannel } from '../dsp/resample';
import { resampledClipSlice, scheduleIdle } from './clipResampleCache';
import { SPATIAL_NEUTRAL, spatialDistanceGain, spatialPanPosition } from '../dsp/spatial';
import {
  automationValueAt,
  resolveAutomation,
  type AutomationKey,
  type SpatialAutomationSpec,
} from './automation';
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
  /**
   * CP1 — the largest |sample| the bus reached BEFORE the ±1 clamp below, over
   * both channels. 0 for an empty render.
   *
   * The clamped output cannot answer "did this session sum over full scale?":
   * by construction its own peak is at most 1.0, so a render that flat-topped
   * for thirty seconds and one that never came near the ceiling read the same.
   * The cover journey's final level check needs the number the clamp REMOVED,
   * so it is measured in the clamp pass itself — the one place the pre-clamp
   * value is still in scope — rather than by a second summation that would have
   * to re-derive every gain, pan and fade this function already applied.
   */
  peakBeforeClamp: number;
}

/**
 * THE dB-to-linear conversion, `10^(dB/20)`. Exported for the same reason the
 * pan laws below are: `mergeClips.ts` bakes a clip's `gainDb` into new audio
 * and must apply the number this renderer applies, not a second copy of the
 * formula that could drift from it. Additive export; every internal caller is
 * unchanged.
 */
export function dbToLinear(db: number): number {
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

/**
 * F0 — the volume lane's linear gain at timeline sample `s`:
 * `dbToLinear(automationValueAt(keys, s, 'volumeDb'))`. Exported for the SAME
 * reason the pan laws are: the realtime `MultitrackPlayer` bakes the identical
 * float expression into its buffers, so live playback and offline mixdown
 * cannot drift (ruling A / trap T5 — one evaluator, one dB→linear conversion,
 * shared verbatim by both engines).
 */
export function autoVolumeGainAt(keys: readonly AutomationKey[], s: number): number {
  return dbToLinear(automationValueAt(keys, s, 'volumeDb'));
}

/**
 * F0 — the pan lane's gain pair at timeline sample `s`, under the law the
 * clip's source channel count selects (`mono` — exactly how the static path
 * picks its law per clip). Shared by both engines like {@link autoVolumeGainAt}.
 * Ruling C rides on this: a mono clip keeps the MONO constant-power law even
 * though the player promotes its BUFFER to two channels — the law choice
 * follows the clip's source, never the buffer.
 */
export function autoPanGainsAt(
  keys: readonly AutomationKey[],
  s: number,
  mono: boolean
): { gL: number; gR: number } {
  const pan = automationValueAt(keys, s, 'pan');
  return mono ? monoPanGains(pan) : stereoBalanceGains(pan);
}

/**
 * F5 — the spatial group's gain pair at timeline sample `s`: the source
 * position (each lane evaluated by the SHARED evaluator — azimuth under its
 * circular short-arc rule — with an absent lane held at its `SPATIAL_NEUTRAL`
 * value) is projected onto the interaural axis (`spatialPanPosition`,
 * dsp/spatial.ts), handed to the SAME pan law the clip's source channel
 * count selects for the `pan` parameter, and attenuated by the inverse
 * distance law. ONE spatialisation function in shared TS, called by both
 * engines (F5 ruling 2 — `PannerNode` has no offline equivalent, so using it
 * would split what you hear from what you export).
 *
 * An absent DISTANCE lane skips the attenuation multiply entirely — the
 * result is bit-identical to multiplying by `spatialDistanceGain(1) = 1`,
 * but the skip keeps the azimuth-only product exactly the pan-lane product
 * shape, and both engines share the skip.
 *
 * SUPERSESSION (F5 ruling 4): while the spec's `spatial` is non-null, BOTH
 * engines take their channel gains from here and the pan lane AND static
 * `Track.pan` are ignored — see `TrackAutomationSpec`'s contract note.
 */
export function autoSpatialGainsAt(
  spatial: SpatialAutomationSpec,
  s: number,
  mono: boolean
): { gL: number; gR: number } {
  const az = spatial.azimuth
    ? automationValueAt(spatial.azimuth, s, 'azimuth')
    : SPATIAL_NEUTRAL.azimuth;
  const el = spatial.elevation
    ? automationValueAt(spatial.elevation, s, 'elevation')
    : SPATIAL_NEUTRAL.elevation;
  const pos = spatialPanPosition(az, el);
  const g = mono ? monoPanGains(pos) : stereoBalanceGains(pos);
  if (!spatial.distance) return g;
  const dg = spatialDistanceGain(automationValueAt(spatial.distance, s, 'distance'));
  return { gL: g.gL * dg, gR: g.gR * dg };
}

function clamp1(v: number): number {
  return v > 1 ? 1 : v < -1 ? -1 : v;
}

/**
 * Reads the clip's source region as per-channel Float32Arrays at the SESSION
 * sample rate. `offsetSample`/`lengthSample` are interpreted so the clip
 * occupies `lengthSample` samples on the session timeline: the number of source
 * samples read is `round(lengthSample · docRate / sessionRate)`
 * (== lengthSample when rates match), and those source samples are resampled up
 * to the session rate. Out-of-range source reads are zero-filled.
 *
 * The returned arrays are exactly `lengthSample` long only when the rates
 * match. Otherwise the length is rounded TWICE — here, and again by
 * `resampleChannel`'s own `round(input.length · toRate / fromRate)` — so a
 * rate-mismatched clip's slice can come back a sample longer or shorter than
 * `lengthSample`. That is why consumers index fades and gains by
 * `lengthSample` and NEVER by the slice length (see `ClipFadeSpec` below):
 * anchoring to the slice tail would put the same fade on different samples in
 * the offline and realtime paths.
 *
 * Exported so the realtime MultitrackPlayer builds its AudioBuffers from the
 * exact same slice/resample logic the offline mixdown uses.
 *
 * MT2-3 — THE RETURNED ARRAYS ARE READ-ONLY, AND MAY ALIAS THE DOCUMENT.
 * A read that lies entirely inside its document at the session's own rate is
 * returned as a `subarray` WINDOW onto `doc.channels[c]`: no allocation, no
 * copy. That is the whole of the matched-rate fix — the old per-sample copy ran
 * ~34.6 M iterations and allocated ~138 MB for two 3-minute stereo clips,
 * inside `play()`, to build arrays that `AudioBuffer.copyToChannel` copied
 * again one line later. Both consumers (this file's mixdown loop and the
 * player's `buildClipBuffer`) only ever READ the slice or write into their own
 * freshly allocated `scaled` array, and that is now a contract: writing into a
 * returned slice would edit the user's document.
 *
 * The zero-fill survives for reads that run off an edge (a clip trimmed past
 * its source, a negative offset), where it is a `set()` of whatever part
 * overlaps rather than a per-sample conditional — same samples, same length,
 * one memcpy.
 */
export function readClipSlice(doc: AudioDocument, clip: Clip, sessionRate: number): Float32Array[] {
  const matched = doc.sampleRate === sessionRate;
  const docSliceLen = matched
    ? clip.lengthSample
    : Math.round((clip.lengthSample * doc.sampleRate) / sessionRate);
  if (docSliceLen <= 0 || doc.channels.length === 0) return [];

  const srcLen = docLength(doc);
  const from = clip.offsetSample;
  // The part of [from, from + docSliceLen) that actually exists in the document.
  const lo = Math.min(Math.max(from, 0), srcLen);
  const hi = Math.min(Math.max(from + docSliceLen, 0), srcLen);
  const inRange = lo === from && hi === from + docSliceLen;

  const slices = doc.channels.map((ch) => {
    if (inRange) return ch.subarray(from, from + docSliceLen);
    const out = new Float32Array(docSliceLen);
    if (hi > lo) out.set(ch.subarray(lo, hi), lo - from);
    return out;
  });

  if (matched) return slices;
  return resampledClipSlice(doc, clip, sessionRate, () =>
    slices.map((ch) => resampleChannel(ch, doc.sampleRate, sessionRate))
  );
}

/**
 * MT2-2 — computes this clip's conversion off the play path, when the renderer
 * is next idle, so `play()` finds it already done.
 *
 * Called at INSERT time (`sessionInsert.placeDocumentsOnTrack`), which is the
 * moment the (document, session rate, window) triple comes into existence and
 * the moment the user is least surprised by the app being busy. A no-op when
 * the rates already agree — after MT2-1's adoption that is the reported flow,
 * which therefore never reaches this code at all.
 *
 * There is no in-flight state to share: the conversion is synchronous, so a
 * `play()` that arrives before the idle callback simply computes it itself
 * through the same cache and the warm-up then finds it done.
 */
export function warmClipResample(doc: AudioDocument, clip: Clip, sessionRate: number): void {
  if (doc.sampleRate === sessionRate) return;
  scheduleIdle(() => {
    try {
      readClipSlice(doc, clip, sessionRate);
    } catch {
      // A warm-up is an optimisation; it may never be the reason anything fails.
      // The real read on the play path will surface any genuine problem.
    }
  });
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
 *
 * Exported (X4) so the clip UI draws the crossfade indicator from the SAME
 * gains this renderer applies, instead of duplicating the constant.
 */
export const CROSSFADE_RHO = 0;

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

/** Timeline length of a session: the furthest clip end over audible tracks. */
function sessionLength(audible: readonly Track[]): number {
  let length = 0;
  for (const t of audible) {
    for (const c of t.clips) {
      length = Math.max(length, c.startSample + c.lengthSample);
    }
  }
  return length;
}

/**
 * CC4 (CJ-6) — accumulates every audible clip into `L`/`R` over the timeline
 * WINDOW `[windowStart, windowEnd)`, with `L[0]` standing for timeline sample
 * `windowStart`.
 *
 * THE loop, factored out of {@link mixdownSession} unchanged so that the
 * peak-only pass below is the same renderer rather than a second one that has to
 * agree with it. The full render calls it once over the whole timeline
 * (`windowStart = 0`, `windowEnd = length`), where every index below reduces to
 * exactly what it was before. Per-sample results cannot depend on the windowing:
 * a sample's value is the sum of the contributions landing on it, tracks and
 * clips are visited in the same order in either mode, and each `+=` still rounds
 * through the same float32 store — which is what lets the peak pass claim
 * EQUALITY with the full render rather than approximation.
 *
 * `length` is the whole timeline length, not the window's: it bounds the clip
 * reads exactly as before, so a clip running past the end is truncated at the
 * same sample either way.
 */
function accumulateWindow(
  audible: readonly Track[],
  docs: Map<string, AudioDocument>,
  sr: number,
  length: number,
  L: Float32Array,
  R: Float32Array,
  windowStart: number,
  windowEnd: number,
  onTrackDone?: () => void
): void {
  for (const t of audible) {
    const trackGain = dbToLinear(t.volumeDb);
    // F0 — the track's active automation, from the SAME resolver the player
    // gates on. `null` for a lane-less track (or zero-key lanes), which keeps
    // the pristine static branches below byte-identical to v1.9.2 (ruling:
    // no existing session may change how it sounds).
    const auto = resolveAutomation(t.automation);
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
      // CC4 (CJ-6): the part of this clip that lands inside the window. `i0`/`i1`
      // are CLIP-LOCAL, so every gain, fade and automation lookup below indexes
      // exactly what it did when the window was the whole timeline (`i0 = 0`,
      // `i1 = n`) — the window only decides which samples are visited and where
      // they are stored.
      const i0 = Math.max(0, windowStart - base);
      const i1 = Math.min(n, windowEnd - base);
      if (i1 <= i0) continue;
      const spec = fadeSpecs.get(c.id);
      if (auto) {
        // F0 — AUTOMATED track: the hoisted static factors above are dead for
        // any automated parameter (trap T4 — keeping `g`/`gL` in the product
        // would double-apply the static value under the envelope), and the
        // envelope moves per sample, so EVERY clip of the track — with or
        // without a fade spec — takes this per-sample loop. The fade-less
        // fast path below must not be reachable here, or automation would be
        // silently dropped for fade-less clips (T4's second half).
        //
        // The per-sample product is written in the EXACT order the player
        // bakes (`buildClipBuffer`): sample · clipGain · v · gPan · e, with
        // the lane factors from the SAME shared `autoVolumeGainAt` /
        // `autoPanGainsAt` — so over a region where every remaining live
        // node gain is exactly 1, the two paths compute identical doubles
        // (the parity suite asserts exact float32 equality there). A static
        // (un-automated) parameter falls back to the track's own field here
        // and to a live node value of the same number in the player.
        // Timeline indexing: `base + i` (trap T6 — never the slice length;
        // a resampled slice's overhang sample evaluates at its true timeline
        // position, past the clip span, exactly like the fade shapes clamp).
        // F5 — placement: the SPATIAL group first (while any spatial lane is
        // active it supersedes the pan lane AND the static pan — ruling 4),
        // then the pan lane, then the static pair. The identical three-way order
        // lives in the player's bake (`buildClipBuffer`), so the two engines
        // cannot disagree about which law governs.
        const clipGain = dbToLinear(c.gainDb);
        for (let i = i0; i < i1; i++) {
          const s = base + i;
          const e = spec ? clipFadeGainAt(spec, i) : 1;
          const v = auto.volume ? autoVolumeGainAt(auto.volume, s) : trackGain;
          const p = auto.spatial
            ? autoSpatialGainsAt(auto.spatial, s, mono)
            : auto.pan
              ? autoPanGainsAt(auto.pan, s, mono)
              : null;
          const pgL = p ? p.gL : gL;
          const pgR = p ? p.gR : gR;
          L[s - windowStart] += chL[i] * clipGain * v * pgL * e;
          R[s - windowStart] += chR[i] * clipGain * v * pgR * e;
        }
      } else if (spec) {
        // Envelope applied PER CLIP, before the `+=` accumulation -- never to
        // the summed bus, and never after the clamp pass below (T22): two
        // crossfading clips must each be shaped before they meet, and the
        // clamp must see the already-shaped (lower) peaks.
        for (let i = i0; i < i1; i++) {
          const e = clipFadeGainAt(spec, i);
          L[base + i - windowStart] += chL[i] * g * gL * e;
          R[base + i - windowStart] += chR[i] * g * gR * e;
        }
      } else {
        for (let i = i0; i < i1; i++) {
          L[base + i - windowStart] += chL[i] * g * gL;
          R[base + i - windowStart] += chR[i] * g * gR;
        }
      }
    }
    onTrackDone?.();
  }
}

export function mixdownSession(
  session: Session,
  docs: Map<string, AudioDocument>,
  onProgress?: (fraction: number) => void
): MixdownResult {
  const sr = session.sampleRate;
  const anySolo = session.tracks.some((t) => t.solo);
  const audible = session.tracks.filter((t) => isAudible(t, anySolo));
  const length = sessionLength(audible);

  if (length === 0) {
    onProgress?.(1);
    return {
      channels: [new Float32Array(0), new Float32Array(0)],
      sampleRate: sr,
      peakBeforeClamp: 0,
    };
  }

  const L = new Float32Array(length);
  const R = new Float32Array(length);

  const total = audible.length;
  let done = 0;
  accumulateWindow(audible, docs, sr, length, L, R, 0, length, () => {
    done++;
    onProgress?.(done / total);
  });

  let peakBeforeClamp = 0;
  for (let i = 0; i < length; i++) {
    const l = L[i] < 0 ? -L[i] : L[i];
    if (l > peakBeforeClamp) peakBeforeClamp = l;
    const r = R[i] < 0 ? -R[i] : R[i];
    if (r > peakBeforeClamp) peakBeforeClamp = r;
    L[i] = clamp1(L[i]);
    R[i] = clamp1(R[i]);
  }

  onProgress?.(1);
  return { channels: [L, R], sampleRate: sr, peakBeforeClamp };
}

/**
 * CC4 (CJ-6) — how many timeline samples the peak pass sums at a time.
 *
 * 1 << 16 is ~1.4 s at 48 kHz and costs two 256 kB buffers whatever the session
 * length: the 15-minute cover session that allocated ~346 MB for a render it
 * threw away now allocates 512 kB. It is large enough that the per-block
 * overhead (one clip-window intersection per clip) is negligible against the
 * per-sample work, and it changes NO arithmetic — see {@link accumulateWindow}.
 */
export const PEAK_BLOCK_SAMPLES = 1 << 16;

/**
 * CC4 (CJ-6) — {@link mixdownSession}'s peak-only mode: the pre-clamp peak of
 * the summed session, WITHOUT ever holding the render.
 *
 * The cover journey's smoothing stage needs one number — did the two tracks sum
 * over full scale? — and was allocating two session-length Float32Arrays to read
 * it, on the renderer thread, at the moment the app is already holding the song,
 * five stems, the instrumental and the take. This sums the same clips through
 * the same accumulator a block at a time and keeps only the running maximum.
 *
 * It returns EXACTLY what `mixdownSession(...).peakBeforeClamp` returns, and the
 * suite asserts that with `toBe` across every fixture shape: same tracks in the
 * same order, same per-sample float32 accumulation, same |value| scan. What it
 * does NOT do is clamp — there is no output to clamp, and the peak is the
 * pre-clamp figure by definition.
 *
 * A rate-mismatched clip is still resampled whole (through the same bounded
 * cache the render uses), so the saving is the master buffers, which is where
 * the session-length cost was. Each block re-requests the SAME cache key, and a
 * hit re-inserts at the back of the LRU, so a clip is converted once and hit
 * thereafter — the one shape that could convert per block is many mismatched
 * clips of ONE document whose slices together exceed that document's own cache
 * budget. The cover journey's session is two clips of two documents, and
 * v1.27's session-rate adoption makes a mismatch the exception rather than the
 * rule; a caller with that shape should use {@link mixdownSession}.
 */
export function mixdownSessionPeak(
  session: Session,
  docs: Map<string, AudioDocument>,
  onProgress?: (fraction: number) => void
): number {
  const sr = session.sampleRate;
  const anySolo = session.tracks.some((t) => t.solo);
  const audible = session.tracks.filter((t) => isAudible(t, anySolo));
  const length = sessionLength(audible);

  if (length === 0) {
    onProgress?.(1);
    return 0;
  }

  const block = Math.min(PEAK_BLOCK_SAMPLES, length);
  const L = new Float32Array(block);
  const R = new Float32Array(block);

  let peak = 0;
  for (let start = 0; start < length; start += block) {
    const end = Math.min(start + block, length);
    L.fill(0);
    R.fill(0);
    accumulateWindow(audible, docs, sr, length, L, R, start, end);
    for (let i = 0; i < end - start; i++) {
      const l = L[i] < 0 ? -L[i] : L[i];
      if (l > peak) peak = l;
      const r = R[i] < 0 ? -R[i] : R[i];
      if (r > peak) peak = r;
    }
    onProgress?.(end / length);
  }
  return peak;
}
