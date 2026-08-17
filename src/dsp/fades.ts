/**
 * Fade and crossfade gain math -- the ONE implementation both auto-remix and
 * the manual clip crossfades use (v1.9, X1).
 *
 * Pure TS: no DOM, no Electron, no `AudioContext`. Runs in a Web Worker.
 *
 * ## Two different things live here, and conflating them is a real bug
 *
 * 1. **Curve shapes** (`fadeInShape` / `fadeOutShape`, and the `...GainAt` /
 *    `applyFade...` wrappers around them). A shape is a SOLO fade: a gain
 *    ramp applied to one signal with nothing sounding against it. It is
 *    monotonic, never exceeds 1, and terminates at 0 and 1 -- with one
 *    documented exception: `equal-power`'s fade-out ends at
 *    `Math.cos(Math.PI / 2)`, which is `6.123e-17` (about -324 dB) rather
 *    than a literal zero. That residue is in the shipped auto-remix tail
 *    fade and is pinned bit-for-bit, so it is a fact to know, not a rounding
 *    error to tidy away.
 *
 * 2. **The crossfade law** (`crossfadeGains`). This is a PAIR of gains for
 *    two signals sounding SIMULTANEOUSLY, normalised by
 *    `k = sqrt(g0^2 + g1^2 + 2*rho*g0*g1)` -- the true summed level at
 *    correlation `rho` -- so that the sum holds its level exactly.
 *
 * **`crossfadeGains(...).gIn` is NOT a fade-in curve.** Its `1/k` factor
 * exists to make the SUM of two simultaneous signals hold its level; applied
 * to one signal on its own it is simply wrong, in either direction depending
 * on the case. With `equal-power` at `rho = 1` it ATTENUATES by `1/sqrt(2)`
 * (-3.01 dB) at the centre, so the fade sags; with `equal-gain` at `rho = 0`
 * it AMPLIFIES by `sqrt(2)` (+3.01 dB) at the centre relative to the honest
 * ramp, so the fade bulges. Neither is a fade. A solo clip fade must come
 * from `fadeInShape` / `fadeInGainAt` / `applyFadeIn`. There is a test that
 * measures exactly this (`fades.test.ts`, "a solo fade is not half a
 * crossfade").
 *
 * ## Why every expression here already existed somewhere in the app
 *
 * Nothing in this module is a fresh derivation. Each shape is written in the
 * exact float form the shipped code already used, because both consumers are
 * bound by output-compatibility:
 *
 * - `equal-gain` out `1 - u` and `equal-power` out `Math.cos(u * (Math.PI/2))`
 *   are verbatim from `remixRender.ts`'s three private fade helpers, which
 *   this module replaces. Auto-remix output must not move by a single sample
 *   (pinned by `remixRender.golden.test.ts`).
 * - `smooth` and `exponential` are verbatim from `FadeEffect.ts`'s curve set
 *   (`(1 - Math.cos(Math.PI * t)) / 2` and `t * t`), including its
 *   fade-out-is-the-mirror convention `curveGain(1 - t)`. So the document
 *   Fade effect can later be routed through this module without changing what
 *   it renders either.
 *
 * The in/out pair of each curve is written out SEPARATELY rather than derived
 * from one another. `sin(u*pi/2)` and `cos((1-u)*pi/2)` are the same number
 * mathematically and not necessarily the same `double`; writing each side in
 * the form the shipped code used is what keeps both consumers bit-stable.
 *
 * ## Numeric contract for later consumers (X3's clip envelope, X5's overlap)
 *
 * - Buffers are `Float32Array[]` and are mutated IN PLACE. Not
 *   `Float64Array`, not a generic `ArrayLike`, and never copy-returning: the
 *   `*=` store rounds each sample to float32, and that rounding is part of
 *   what the auto-remix pin fixes. A path that keeps intermediates in double
 *   produces different audio from an identical-looking loop.
 * - `fadeInGainAt` / `fadeOutGainAt` exist so a consumer that multiplies its
 *   own scalar envelope (rather than calling an in-place buffer helper) gets
 *   the SAME float expressions instead of re-deriving them.
 * - `rho` stays restricted to `[0, 1]`. It is a measured correlation in
 *   auto-remix, not a knob. A caller with no correlation measurement
 *   available -- which is every multitrack path, there is no alignment search
 *   there -- must pass `rho = 0` deliberately (the honest assumption for two
 *   unrelated clips: the pair is then normalised for power summation), not
 *   invent an estimate. Negative `rho` is clamped to 0 rather than honoured
 *   because
 *   `k = sqrt(1 + rho)` at the centre is singular at `rho = -1`; the cost is a
 *   bounded UNDER-delivery of level on genuinely anti-correlated material
 *   (-3.01 dB at `rho = -0.5`), never an unbounded boost.
 * - Singleton windows: a one-sample ramp has no `i / (n - 1)` to evaluate, so
 *   the gain is whatever the caller says it is via `singletonGain`. The two
 *   conventions in the shipped renderer are DELIBERATELY different -- a fade
 *   that must meet adjacent silence ends at exactly 0 even when it is one
 *   sample long, while a fade that merely trails off must not zero a
 *   legitimate final sample -- so this is a parameter, not a house rule.
 */

/**
 * The curve set, named for what each one DOES to the level rather than for
 * its formula, because these names reach the UI.
 *
 * The distinction that matters when picking one: two signals sum differently
 * depending on whether they are correlated. Identical material sums by
 * AMPLITUDE (gains should add to 1); independent material sums by POWER
 * (squared gains should add to 1). A curve that is right for one is 3 dB
 * wrong for the other, which is why one curve for everything is not enough.
 *
 * - `equal-gain` -- linear ramps, gains add to 1. Exact for correlated
 *   material (the same take on both sides, a loop repeating into itself);
 *   dips ~3 dB at the centre on unrelated material.
 * - `equal-power` -- quarter-cosine/quarter-sine ramps, squared gains add
 *   to 1. Exact for uncorrelated material (two different instruments, the
 *   normal case when crossfading two clips); bumps ~3 dB at the centre on
 *   identical material.
 * - `smooth` -- an S-curve that also adds to 1, but leaves and arrives with
 *   zero slope, so the level change is gentlest exactly where a fade is most
 *   noticeable: at its two ends.
 * - `exponential` -- squared ramps. The outgoing side drops away quickly and
 *   the incoming side stays quiet longer, so a solo pair leaves a deliberate
 *   hole in the middle (-6 dB by amplitude at the centre). Wanted when the
 *   two sides should not blend.
 *
 * Those level statements describe the SOLO shapes. Fed through
 * `crossfadeGains`, every curve becomes exactly level-preserving at the
 * given `rho` -- the `k` normaliser guarantees it for any non-negative gain
 * pair -- and the curve then decides only the TRAJECTORY of the handover, not
 * its loudness.
 */
export type FadeCurve = 'equal-gain' | 'equal-power' | 'smooth' | 'exponential';

/** Every curve, in the order a picker should offer them. */
export const FADE_CURVES: readonly FadeCurve[] = ['equal-power', 'equal-gain', 'smooth', 'exponential'];

/** Short UI labels (ruling 2: name curves by what they DO to the level, not
 * by their formula). 'Equal power'/'Equal gain' are behaviour names with
 * direct Pro Tools precedent (they say which summing law holds the level).
 * `exponential` is DELIBERATELY NOT labelled "Exponential" (X1's flag: the
 * shape is `t²` — quadratic, so the formula name was wrong twice over):
 * 'Ducked' names the audible behaviour — the level is held low through most
 * of the fade, leaving a deliberate dip at a crossfade's midpoint. The curve
 * ID stays `'exponential'` because it is persisted in `.audm` files (X2);
 * only the user-facing string is a UI decision (X4). */
export const FADE_CURVE_LABELS: Record<FadeCurve, string> = {
  'equal-power': 'Equal power',
  'equal-gain': 'Equal gain',
  smooth: 'Smooth',
  exponential: 'Ducked',
};

/** One line each, for a tooltip or a helper row under the picker. */
export const FADE_CURVE_DESCRIPTIONS: Record<FadeCurve, string> = {
  'equal-power': 'Holds the level when the two sides are different material. The safe default.',
  'equal-gain': 'Holds the level when both sides are the same material, such as a loop repeating.',
  smooth: 'Equal gain with eased ends -- the least noticeable fade on speech and long tails.',
  exponential: 'Drops away fast and comes back late, leaving a deliberate dip at the join.',
};

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

/**
 * Fade-IN gain at normalised ramp position `u` in `[0, 1]`: `0` at `u = 0`,
 * `1` at `u = 1`, monotonically non-decreasing between, never above 1. `u` is
 * clamped, so this is safe to call with an unchecked position.
 */
export function fadeInShape(u: number, curve: FadeCurve): number {
  const t = clamp01(u);
  switch (curve) {
    case 'equal-gain':
      return t;
    case 'equal-power':
      return Math.sin(t * (Math.PI / 2));
    case 'smooth':
      return (1 - Math.cos(Math.PI * t)) / 2;
    case 'exponential':
      return t * t;
  }
}

/**
 * Fade-OUT gain at normalised ramp position `u` in `[0, 1]`: `1` at `u = 0`,
 * `0` at `u = 1`. The mathematical mirror of `fadeInShape` (`f_out(u) =
 * f_in(1 - u)`), but written out per curve in the exact form the shipped code
 * used rather than computed as `fadeInShape(1 - u)` -- see the module doc
 * comment on why the two are not interchangeable at the bit level.
 */
export function fadeOutShape(u: number, curve: FadeCurve): number {
  const t = clamp01(u);
  switch (curve) {
    case 'equal-gain':
      return 1 - t;
    case 'equal-power':
      return Math.cos(t * (Math.PI / 2));
    case 'smooth':
      return (1 - Math.cos(Math.PI * (1 - t))) / 2;
    case 'exponential':
      return (1 - t) * (1 - t);
  }
}

/**
 * Fade-IN gain for step `i` of an `n`-step ramp -- the per-sample scalar
 * accessor for consumers that build their own envelope instead of calling an
 * in-place buffer helper. Using this rather than re-deriving `i / (n - 1)` at
 * the call site is what keeps every consumer on the same float expressions.
 *
 * `singletonGain` is returned when `n <= 1`, where there is no ramp to
 * evaluate. It defaults to `1` (a one-sample fade leaves the sample alone);
 * pass `0` when the fade has to terminate in silence regardless of length.
 */
export function fadeInGainAt(i: number, n: number, curve: FadeCurve, singletonGain = 1): number {
  return n > 1 ? fadeInShape(i / (n - 1), curve) : singletonGain;
}

/** Fade-OUT counterpart of `fadeInGainAt`. `singletonGain` defaults to `1`
 * (the "do not zero a legitimate final sample" convention); the auto-remix
 * tail taper passes `0` because it must meet adjacent zero-padded silence. */
export function fadeOutGainAt(i: number, n: number, curve: FadeCurve, singletonGain = 1): number {
  return n > 1 ? fadeOutShape(i / (n - 1), curve) : singletonGain;
}

/**
 * Fades the LAST `min(fadeLen, length)` samples of every channel down to the
 * curve's endpoint, in place. No-op for `fadeLen <= 0`.
 *
 * Mutates the buffers it is given; it does not copy. Callers that must not
 * disturb the original pass a slice (auto-remix's exact-length trim does),
 * and callers that are shaping the buffer they will return pass it directly.
 * A copy-returning variant would silently drop the fade for the latter.
 */
export function applyFadeOut(channels: Float32Array[], fadeLen: number, curve: FadeCurve, singletonGain = 1): void {
  if (fadeLen <= 0) return;
  const len = channels[0].length;
  const start = Math.max(0, len - fadeLen);
  const n = len - start;
  for (let i = 0; i < n; i++) {
    const g = fadeOutGainAt(i, n, curve, singletonGain);
    for (let c = 0; c < channels.length; c++) channels[c][start + i] *= g;
  }
}

/** Fade-IN counterpart of `applyFadeOut`: shapes the FIRST
 * `min(fadeLen, length)` samples of every channel, in place. */
export function applyFadeIn(channels: Float32Array[], fadeLen: number, curve: FadeCurve, singletonGain = 1): void {
  if (fadeLen <= 0) return;
  const len = channels[0].length;
  const n = Math.min(fadeLen, len);
  for (let i = 0; i < n; i++) {
    const g = fadeInGainAt(i, n, curve, singletonGain);
    for (let c = 0; c < channels.length; c++) channels[c][i] *= g;
  }
}

/**
 * Fades out over `[endPos - fadeLen, endPos)` -- a window ending at an
 * ARBITRARY position, unlike `applyFadeOut`'s buffer-end anchor.
 *
 * Only the near edge is clamped (`start` never goes below 0, and the ramp
 * compresses into what is left). It deliberately does NOT consult
 * `channels[0].length`: auto-remix's tail taper uses this to reach BACKWARD
 * past its own write cursor into the previous segment's already-written
 * audio, which is contiguous source material, and a "defensive" clamp to the
 * current segment reintroduces the click this fade exists to remove.
 * Out-of-range writes on a typed array are silent no-ops, which is the
 * behaviour relied on here, not an oversight.
 */
export function applyFadeOutEndingAt(
  channels: Float32Array[],
  endPos: number,
  fadeLen: number,
  curve: FadeCurve,
  singletonGain = 1
): void {
  if (fadeLen <= 0) return;
  const start = Math.max(0, endPos - fadeLen);
  const n = endPos - start;
  for (let i = 0; i < n; i++) {
    const g = fadeOutGainAt(i, n, curve, singletonGain);
    for (let c = 0; c < channels.length; c++) channels[c][start + i] *= g;
  }
}

/** Fade-IN counterpart of `applyFadeOutEndingAt`: fades in over
 * `[startPos, startPos + fadeLen)`. Mirrors it exactly -- only the near edge
 * (here, `startPos < 0`) is clamped, and the buffer's own length is never
 * consulted, so a window running past the end simply has its tail writes
 * silently dropped. */
export function applyFadeInStartingAt(
  channels: Float32Array[],
  startPos: number,
  fadeLen: number,
  curve: FadeCurve,
  singletonGain = 1
): void {
  if (fadeLen <= 0) return;
  const start = Math.max(0, startPos);
  const n = startPos + fadeLen - start;
  for (let i = 0; i < n; i++) {
    const g = fadeInGainAt(i, n, curve, singletonGain);
    for (let c = 0; c < channels.length; c++) channels[c][start + i] *= g;
  }
}

/**
 * The correlation-compensated, level-preserving crossfade pair.
 *
 * `g0 = fadeOutShape(t)`, `g1 = fadeInShape(t)`,
 * `k = sqrt(g0^2 + g1^2 + 2*rho*g0*g1)`, and the returned gains are `g0/k`
 * and `g1/k`. `k^2` is exactly the summed power of two signals with
 * correlation `rho` at those gains, so dividing by `k` makes
 *
 *     gOut^2 + gIn^2 + 2*rho*gOut*gIn === 1
 *
 * hold identically -- for every `t`, every `rho` in `[0, 1]`, and every
 * curve. An exact identity, not a blend that happens to sound acceptable.
 * `k` is always real and positive (`g0, g1 >= 0` and `rho >= 0` make every
 * term non-negative, and both gains are never simultaneously 0), so the
 * result is always bounded.
 *
 * NOTE ON `k` FOR `equal-power`. There `g0^2 + g1^2` is `cos^2 + sin^2`,
 * which is 1 by construction -- and NOT exactly 1 in floating point. That
 * path therefore uses the literal `1`, giving `sqrt(1 + 2*rho*g0*g1)`, which
 * is character-for-character the expression auto-remix shipped and is pinned
 * bit-for-bit by `remixRender.golden.test.ts`. The general form is used only
 * for the curves that need it. The two are the same number mathematically;
 * only one of them is the one already in production.
 *
 * At `rho = 1` with `equal-power`, `k` collapses to `g0 + g1` and the pair
 * becomes `g0/(g0+g1)`, `g1/(g0+g1)`: an equal-GAIN crossfade -- the correct
 * law for two views of the same material, where an equal-power fade would put
 * a +3 dB bump in the middle. At `rho = 0` with `equal-power`, `k` is 1 and
 * the pair is the plain cosine/sine.
 *
 * `t` and `rho` are both clamped to `[0, 1]`, defensively -- this is meant to
 * be usable as a standalone, robust pure function, not merely an internal
 * helper.
 *
 * WHY `rho` IS CLAMPED TO `>= 0`, NOT JUST `<= 1` (measured, not assumed):
 * `k = sqrt(1 + 2*rho*g0*g1)` is only safely bounded away from zero for
 * `rho >= 0`. For `rho < 0`, `k` SHRINKS -- at `t = 0.5` with `equal-power`
 * (`g0 = g1 = 1/sqrt(2)`, so `g0*g1 = 0.5`), `k = sqrt(1 + rho)`, which is
 * SINGULAR at `rho = -1`: unbounded gain at exactly the point genuinely
 * anti-correlated material would need it most. Clamping sidesteps that by
 * never handing a negative `rho` to the formula at all. The cost is that
 * anti-correlated material is rendered as if `rho = 0`, which UNDER-delivers
 * power rather than over-delivering it: recomputed directly (power
 * `= 1 + 2*rho*gOut*gIn = 1 + rho` at the centre), the dip is -1.25 dB at
 * `rho = -0.25`, -3.01 dB at `rho = -0.50`, -6.02 dB at `rho = -0.75`. A
 * quiet splice, never a blown-up one -- a bounded, measured trade-off rather
 * than an unexamined gap.
 *
 * NOT A FADE-IN. `gIn` alone is not a unity-terminating fade-in curve -- see
 * the module doc comment.
 *
 * TWO CURVES (v1.9 X3, additive). A manual clip crossfade is "the outgoing
 * clip's fade-OUT against the incoming clip's fade-IN", and the two clips may
 * carry DIFFERENT curve choices on those facing edges. `curveIn` names the
 * incoming side's curve and defaults to `curve`, so every pre-existing caller
 * (auto-remix passes a single curve) is bit-for-bit unchanged. The `k`
 * identity is curve-agnostic -- it holds for ANY non-negative gain pair, so a
 * mixed pair is exactly as level-preserving as a matched one. The equal-power
 * fast path below applies only when BOTH sides are `equal-power`; a mixed
 * pair involving `equal-power` goes through the general form (nothing pinned
 * ever produced a mixed pair, so there is no bit-compatibility to preserve
 * there).
 *
 * The both-`equal-power` branch computes its own `cos`/`sin` rather than
 * calling `fadeOutShape`/`fadeInShape`, so that this function's arithmetic is
 * character-for-character what shipped in `remixRender.ts`. Auto-remix output
 * is pinned bit-for-bit and the gain law has its own double-precision pin;
 * routing the default path through a differently-parenthesised argument is
 * not a change worth risking for four saved lines.
 */
export function crossfadeGains(
  t: number,
  rho: number,
  curve: FadeCurve = 'equal-power',
  curveIn: FadeCurve = curve
): { gOut: number; gIn: number } {
  const tc = Math.max(0, Math.min(1, t));
  const rc = Math.max(0, Math.min(1, rho));
  let g0: number;
  let g1: number;
  let sumSquares: number;
  if (curve === 'equal-power' && curveIn === 'equal-power') {
    const theta = (Math.PI * tc) / 2;
    g0 = Math.cos(theta);
    g1 = Math.sin(theta);
    sumSquares = 1;
  } else {
    g0 = fadeOutShape(tc, curve);
    g1 = fadeInShape(tc, curveIn);
    sumSquares = g0 * g0 + g1 * g1;
  }
  const k = Math.sqrt(sumSquares + 2 * rc * g0 * g1);
  return { gOut: g0 / k, gIn: g1 / k };
}
