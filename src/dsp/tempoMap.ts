/**
 * Task R7 — variable-rate Match Tempo: a tempo MAP, not a single ratio.
 *
 * `docs/KNOWN_LIMITATIONS.md` recorded "Match Tempo applies ONE ratio across
 * the region" as an *inherent* limit. It is not one. It is a CALLER limit:
 * `timeStretchVariableLinked` (`wsola.ts:336`) has done variable-rate,
 * stereo-linked, pitch-preserving stretching since F1, and F9 already drives it
 * for timing alignment. Match Tempo simply never supplied a map. This module
 * supplies one.
 *
 * ---------------------------------------------------------------------------
 * WHAT ONE RATIO COSTS — MEASURED, not asserted
 * ---------------------------------------------------------------------------
 * On synthetic accelerandi whose beat positions are exact by construction, a
 * single ratio (the one that matches the region's total duration — the *most
 * favourable* single ratio there is, since it pins the first and last beat
 * exactly) leaves every interior beat off the target grid:
 *
 * | fixture (24 s, 48 kHz)        | slope       | one ratio, median / max |err| | this map, median / max |
 * |-------------------------------|-------------|-------------------------------|------------------------|
 * | 108→112 BPM, target 110       | 0.17 BPM/s  | 78.8 ms / 104.4 ms            | 0.36 ms / 4.6 ms       |
 * | 100→120 BPM, target 110       | 0.83 BPM/s  | 393.9 ms / 525.8 ms           | 1.8 ms / 4.6 ms        |
 * | 90→140 BPM, target 115        | 2.08 BPM/s  | 951.3 ms / 1274.4 ms          | 4.4 ms / 9.8 ms        |
 * | steady 120, target 110 (ctrl) | 0           | 0 ms / 0 ms                   | identical, byte for byte |
 *
 * 525.8 ms is 0.96 of a 545 ms beat: on gentle accelerando the correction is
 * off by nearly a whole beat in the middle of the region. The map's residual is
 * not the map — it is WSOLA's own placement error, which is what the last
 * column measures, and it does not grow with the slope the way the single
 * ratio's does.
 *
 * ---------------------------------------------------------------------------
 * RULING 1 — the map comes from a CONFIRMED grid, never from fresh detection
 * ---------------------------------------------------------------------------
 * This module takes **beat positions**, never audio and never a BPM to detect.
 * On the user's own material, detected tempo confidence ranged 0.003–0.167
 * across seven sources against the app's own `CONFIDENCE_LOW = 0.35`, and
 * separation localised the ambiguity rather than resolving it. A single wrong
 * ratio is uniformly wrong and a musician hears it at once; **a wrong tempo map
 * is wrong differently in every bar**, which is harder to hear, harder to
 * attribute and impossible to undo by ear. So the caller passes the tracked
 * grid the user has already seen and can edit (×2/÷2 re-tracking, manual BPM,
 * downbeat shift), and `TempoDialog` will not enable the variable mode until
 * the user confirms that grid — exactly the gate F9's `AlignTimingDialog` uses.
 *
 * ---------------------------------------------------------------------------
 * RULING 3 — bounded, monotonic, and honest at the bound
 * ---------------------------------------------------------------------------
 * **The bound is `wsola.ts`'s own `MIN_RATIO`/`MAX_RATIO`, imported, not
 * restated.** F9's warp bounds itself by the *transparency* band (0.88–1.14)
 * because it stretches sung vowels and must be inaudible. Match Tempo is the
 * opposite case: the user has explicitly asked for a tempo change of whatever
 * size they typed, and `tempoService.ts`'s `checkTempoChange` already refuses
 * anything outside `[MIN_RATIO, MAX_RATIO]` for the constant path. Bounding the
 * LOCAL ratio by the same pair is what makes the variable path unable to ask
 * WSOLA for something the constant path would have refused — and using the
 * imported constants rather than a fourth copy of the numbers is what stops the
 * two drifting apart. `tempoMap.test.ts` pins the defaults equal to them.
 *
 * **Monotonic by construction.** Every knot interval is placed with a strictly
 * positive output width (`d * ratio` with `d > 0` and `ratio >= minRatio > 0`),
 * so `knotsOut` is strictly ascending without needing a repair pass.
 *
 * **At the bound it moves as far as it can and says so.** An interval whose
 * requested spacing would need a ratio outside the band is placed at the
 * nearest end of the band, and the beat that closes it is named in
 * {@link TempoMap.clampedIndices}. Nothing is silently clamped and nothing is
 * silently refused.
 *
 * **Where the grid says nothing, nothing is invented.** The head before the
 * first tracked beat and the tail after the last have no measured beat interval
 * of their own, so they take the ratio of the interval ADJACENT to them rather
 * than a ratio of 1. Ratio 1 there would be a discontinuity of exactly the
 * amount the feature is correcting — the region would start and end at the
 * original tempo — and it is also what would break the constant-tempo
 * equivalence below.
 *
 * ---------------------------------------------------------------------------
 * THE CONSTANT-TEMPO CASE IS BYTE-IDENTICAL, AND THAT IS MEASURED
 * ---------------------------------------------------------------------------
 * A perfectly even grid makes every local ratio equal, so this map degenerates
 * to `analysisPosAt(v) = v / r` — and `timeStretchVariableLinked` fed that map
 * produces output **byte for byte identical** to `timeStretchLinked` at `r`.
 * Verified over 20 s of noise at five ratios, four of them non-dyadic
 * (1.0909…, 2, 0.750001875, 0.666…, 0.871083259): **0 differing samples of
 * 1 047 273 / 1 920 000 / 720 002 / 640 000 / 836 240**. Pinned by test, so the
 * new path provably cannot disturb the old one. (No uniform-ratio short circuit
 * is therefore needed, and none is written — a branch no test can kill is a
 * branch that is not carrying anything.)
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS MODULE DOES NOT DO
 * ---------------------------------------------------------------------------
 * It does not touch METER. A 4/4 song with a 3/4 bridge breaks the remix's
 * phrase arithmetic, not Match Tempo's ratio, and the two have different causes
 * and different fixes — see `docs/KNOWN_LIMITATIONS.md`, which now names them
 * separately, and `.superpowers/sdd/task-R7-report.md` for the measurement that
 * scoped them apart.
 */

import { analysisPosAt, type PiecewiseTimeMap } from './timingWarp';
import { MAX_RATIO, MIN_RATIO, timeStretchVariableLinked } from './wsola';

/** Why {@link buildTempoMap} produced an identity map instead of a correction. */
export type TempoMapRefusal =
  /** The region has no length, so there is nothing to stretch. */
  | 'empty-region'
  /** The target beat spacing is not a usable positive number of samples. */
  | 'invalid-spacing'
  /** Fewer than two usable beats inside the region: with one beat (or none)
   * there is not a single MEASURED interval, so there is no local tempo to
   * follow and a map would be pure invention. */
  | 'not-enough-beats';

export interface TempoMapOptions {
  /** Local ratio floor. Defaults to `wsola.ts`'s {@link MIN_RATIO}. */
  minRatio?: number;
  /** Local ratio ceiling. Defaults to `wsola.ts`'s {@link MAX_RATIO}. */
  maxRatio?: number;
}

export interface TempoMap extends PiecewiseTimeMap {
  /** Indices into the CALLER's beat array for the beats that became knots. A
   * beat is dropped for being out of range, out of order or non-finite. */
  acceptedIndices: number[];
  /** Where each accepted beat LANDS, in output samples, parallel to
   * {@link acceptedIndices}. This is what a post-match beat-marker grid must be
   * written at: once any interval has been clamped the beats are no longer
   * `first + i * targetSpacing` apart, so re-deriving them from the target BPM
   * would place markers where the audio's beats are not. Empty for an identity
   * map. */
  placed: Float64Array;
  /** Caller indices of the beats whose PRECEDING interval could not be given
   * the requested spacing because the ratio bound held it back. The interval
   * was stretched as far as the bound allows; this is how the caller says so
   * rather than under-delivering silently. */
  clampedIndices: number[];
  /** Smallest realised local ratio over all knot intervals, or 1 for an
   * identity map. Together with {@link maxLocalRatio} this is what lets the UI
   * label the WORST segment's quality rather than the average's. */
  minLocalRatio: number;
  /** Largest realised local ratio over all knot intervals, or 1 for an
   * identity map. */
  maxLocalRatio: number;
  /** True when nothing moves — the caller should skip the stretch entirely.
   * See {@link applyTempoMap}. */
  identity: boolean;
  /** Set when {@link identity} is true because the inputs could not describe a
   * correction, rather than because the material is already at the target.
   * `null` when a real map was built, and `null` when the grid genuinely
   * already matches the target. */
  refusal: TempoMapRefusal | null;
}

function identityMap(inLen: number, refusal: TempoMapRefusal | null): TempoMap {
  const len = Math.max(0, inLen);
  return {
    inLen: len,
    outLen: len,
    knotsIn: Float64Array.from([0, len]),
    knotsOut: Float64Array.from([0, len]),
    acceptedIndices: [],
    placed: new Float64Array(0),
    clampedIndices: [],
    minLocalRatio: 1,
    maxLocalRatio: 1,
    identity: true,
    refusal,
  };
}

/**
 * Builds the monotonic, ratio-bounded time map that puts every tracked beat one
 * `targetSpacing` after the previous one.
 *
 * `beatSamples` are REGION-RELATIVE positions from a confirmed beat grid (see
 * RULING 1 in the module header) and `targetSpacing` is `60 / targetBpm *
 * sampleRate` — a fractional sample count, deliberately not rounded, because
 * rounding it would re-introduce a drift of up to half a sample per beat, which
 * over a 300-beat region is exactly the accumulating error this module exists
 * to remove.
 *
 * ### Which beats are used
 * A beat is accepted when it is finite, inside `[0, inLen)` and strictly after
 * the previously accepted one. Out-of-order or duplicate beats are DROPPED
 * rather than sorted or merged: a caller handing over an unsorted grid has a
 * bug upstream, and repairing it here would move audio according to a guess
 * about what it meant. Fewer than two accepted beats means no measured interval
 * exists at all, and the map is the identity with `refusal:
 * 'not-enough-beats'`.
 *
 * ### Where the knots go
 * `knotsIn` is `[0?, b0, b1, …, bN-1, inLen?]` — the region start and end are
 * included only when they are not already a beat. Each measured interval
 * `[b(i-1), b(i)]` is given an output width of `targetSpacing`, clamped so that
 * its local ratio stays inside `[minRatio, maxRatio]`; the head and the tail
 * take the ratio of the interval adjacent to them (see the module header).
 * Output positions accumulate, so a clamped interval shifts everything after it
 * — which is the truthful consequence of not being able to stretch that far,
 * and is why {@link TempoMap.clampedIndices} exists.
 */
export function buildTempoMap(
  beatSamples: ArrayLike<number>,
  inputLength: number,
  targetSpacing: number,
  opts: TempoMapOptions = {}
): TempoMap {
  const inLen = Math.max(0, Math.floor(inputLength));
  if (inLen <= 0) return identityMap(inLen, 'empty-region');
  if (!Number.isFinite(targetSpacing) || targetSpacing <= 0) return identityMap(inLen, 'invalid-spacing');

  // The band is held inside the engine's own limits and forced to contain 1, so
  // the identity placement is always feasible and a caller cannot ask for a
  // band like [1.2, 1.5] that no in-range interval could satisfy.
  const minRatio = Math.min(1, Math.max(MIN_RATIO, opts.minRatio ?? MIN_RATIO));
  const maxRatio = Math.max(1, Math.min(MAX_RATIO, opts.maxRatio ?? MAX_RATIO));

  // --- accept beats --------------------------------------------------------
  const acceptedIndices: number[] = [];
  const sources: number[] = [];
  // `-Infinity`, not `-1`: with `-1` the ordering guard below ALSO rejected
  // every integer negative, so the range guard and the ordering guard overlapped
  // and neither was pinned — a mutation deleting `b < 0` survived the whole
  // suite. They now have one job each, and `b < 0` is the only thing that
  // rejects a position outside the region (including a fractional one in
  // `(-1, 0)`, which `-1` silently admitted).
  let prev = -Infinity;
  for (let i = 0; i < beatSamples.length; i++) {
    const b = beatSamples[i];
    if (!Number.isFinite(b)) continue;
    if (b < 0 || b >= inLen) continue;
    if (b <= prev) continue;
    acceptedIndices.push(i);
    sources.push(b);
    prev = b;
  }
  if (sources.length < 2) return identityMap(inLen, 'not-enough-beats');

  // --- knot input positions ------------------------------------------------
  // A head knot is needed only when the first beat is not already the region
  // start. A TAIL knot is always needed: acceptance requires `b < inLen`, so
  // the last beat is strictly inside and `inLen` is never already a knot —
  // making it conditional would add a branch no test could ever kill.
  const headKnot = sources[0] > 0;
  const k = sources.length + (headKnot ? 1 : 0) + 1;
  const knotsIn = new Float64Array(k);
  const firstBeatKnot = headKnot ? 1 : 0;
  for (let j = 0; j < sources.length; j++) knotsIn[firstBeatKnot + j] = sources[j];
  knotsIn[k - 1] = inLen;

  // --- output widths, interval by interval ---------------------------------
  // Beat interval j (j = 1 .. sources.length-1) spans knots
  // [firstBeatKnot+j-1, firstBeatKnot+j] and wants `targetSpacing`.
  const widths = new Float64Array(k - 1);
  const clampedIndices: number[] = [];
  let minLocalRatio = Infinity;
  let maxLocalRatio = -Infinity;

  for (let j = 1; j < sources.length; j++) {
    const d = sources[j] - sources[j - 1];
    const lo = d * minRatio;
    const hi = d * maxRatio;
    let w = targetSpacing;
    // `<` and `<=` are interchangeable in both arms, and that is proven rather
    // than assumed: at `w === lo` the assignment `w = lo` is a no-op, so the
    // realised width, the ratio and the `w !== targetSpacing` clamp report all
    // evaluate identically either way. Both forms were run as mutations and
    // scored EQUIVALENT. The strict form is kept because it says what it means:
    // only a request OUTSIDE the band is altered.
    if (w < lo) w = lo;
    else if (w > hi) w = hi;
    if (w !== targetSpacing) clampedIndices.push(acceptedIndices[j]);
    widths[firstBeatKnot + j - 1] = w;
    const r = w / d;
    if (r < minLocalRatio) minLocalRatio = r;
    if (r > maxLocalRatio) maxLocalRatio = r;
  }

  // Head and tail inherit the ADJACENT interval's realised ratio (module
  // header): they carry no measured beat interval of their own, and a ratio of
  // 1 there would leave the region's ends at the original tempo.
  const firstRatio = widths[firstBeatKnot] / (sources[1] - sources[0]);
  const lastRatio =
    widths[firstBeatKnot + sources.length - 2] / (sources[sources.length - 1] - sources[sources.length - 2]);
  if (headKnot) widths[0] = sources[0] * firstRatio;
  widths[k - 2] = (inLen - sources[sources.length - 1]) * lastRatio;

  // --- accumulate ----------------------------------------------------------
  const knotsOut = new Float64Array(k);
  for (let j = 1; j < k; j++) knotsOut[j] = knotsOut[j - 1] + widths[j - 1];

  const placed = new Float64Array(sources.length);
  for (let j = 0; j < sources.length; j++) placed[j] = knotsOut[firstBeatKnot + j];

  const outLen = Math.round(knotsOut[k - 1]);
  let identity = true;
  for (let j = 1; j < k; j++) {
    if (Math.abs(knotsOut[j] - knotsIn[j]) > 1e-9) {
      identity = false;
      break;
    }
  }

  return {
    inLen,
    outLen,
    knotsIn,
    knotsOut,
    acceptedIndices,
    placed,
    clampedIndices,
    minLocalRatio,
    maxLocalRatio,
    identity,
    refusal: null,
  };
}

/**
 * Applies `map` to `channels` through `timeStretchVariableLinked`, which runs
 * ONE similarity search over the channel mean and applies the same offsets to
 * every channel — so the inter-channel phase relationship survives exactly as
 * it does for the constant path and for Pitch Correct.
 *
 * An identity map returns **copies of the input samples, byte for byte**. It
 * does NOT run WSOLA at ratio 1: the similarity search is a near-passthrough,
 * not a passthrough, so "nothing to correct changes nothing" has to be a short
 * circuit to be true (F9 found the same, and found a test that had been passing
 * vacuously because a fixture starting at zero hides the difference).
 */
export function applyTempoMap(
  channels: Float32Array[],
  sampleRate: number,
  map: TempoMap,
  onProgress?: (fraction: number) => void
): Float32Array[] {
  if (map.identity) {
    onProgress?.(1);
    return channels.map((c) => Float32Array.from(c));
  }
  return timeStretchVariableLinked(channels, sampleRate, map.outLen, (v) => analysisPosAt(map, v), onProgress);
}
