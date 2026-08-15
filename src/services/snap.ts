/**
 * Task B4 — the "magnet": quantising a candidate position onto the nearest
 * musically meaningful target.
 *
 * The user's words were *"make the bar be able to magnet on those tics"*. This
 * module is the whole of the magnet's arithmetic, and deliberately nothing
 * else: no DOM, no store, no React, no imports at all. Everything here is a
 * pure function of `(position, targets, samplesPerPixel, tolerancePx)`, which
 * is what makes the interesting cases (nearest, tie, boundary, empty set,
 * far-away targets, cost on a 100 000-beat grid) testable without simulating a
 * single pointer event. Who the targets are, and whether snapping is on at all,
 * are questions for the layers above (`snapPreference.ts`, `editorSnapTargets`,
 * `sessionSnapTargets`).
 *
 * ---------------------------------------------------------------------------
 * THE TOLERANCE IS IN SCREEN PIXELS (plan ruling 3)
 * ---------------------------------------------------------------------------
 * A fixed *sample* tolerance is unusable: at the editor's default zoom (512
 * samples/px) 2 000 samples is 4 px — a natural pull — while zoomed in to 50
 * samples/px the same 2 000 samples is 40 px, a magnet that yanks the cursor
 * half a centimetre away from where the user pointed. The rule is therefore
 * "within N screen pixels of a target", so the tolerance in samples is
 * `tolerancePx · samplesPerPixel` and is recomputed at every zoom.
 *
 * `samplesPerPixel` is an explicit ARGUMENT, never read from a store (trap 26):
 * the app has two independent zoom sources — the editor's `zoom.samplesPerPixel`
 * (app store) and the multitrack's `mtZoom.samplesPerPixel` (session store) —
 * and a helper that reached for "the" zoom would quantise the multitrack at the
 * editor's scale.
 *
 * ---------------------------------------------------------------------------
 * INTEGRALITY (trap 21)
 * ---------------------------------------------------------------------------
 * `cursorSample` and `selection` are floats today and two existing tests pin
 * exact float equality on them. So this module rounds NOTHING. It returns
 * either
 *   - a target verbatim — integral, because every target source is integral
 *     (`beatSamples` is an `Int32Array`, `Marker.positionSample` and
 *     `Clip.startSample` are whole samples), or
 *   - the caller's own value, bit for bit, when nothing was near enough.
 * A snapped position is therefore an integer and an unsnapped one keeps
 * whatever the pixel→sample map produced, which is exactly what lets the two
 * pinned expectations stand unchanged.
 */

/**
 * Snap radius, in CSS pixels. A candidate within this many pixels of a target
 * is pulled onto it.
 *
 * **8 px**, chosen against three constraints rather than by feel:
 *  - It must be comfortably LARGER than the gestures' own dead zones — the
 *    editor's 3 px drag threshold (`exceedsDragThreshold`) and the clip's 4 px
 *    `DRAG_THRESHOLD` — or the magnet would only ever engage after the pointer
 *    had already travelled further than the pull it applies, which reads as
 *    "the snap does nothing".
 *  - It must be well UNDER half the spacing of adjacent targets at a working
 *    zoom, so two neighbouring beats never both compete for the pointer: at 120
 *    BPM / 44.1 kHz a beat is 22 050 samples, which at the editor's default 512
 *    samples/px is ~43 px apart — half of that is ~21 px, so 8 px leaves a wide
 *    unsnapped corridor in which a deliberate off-grid position is still
 *    reachable without holding the modifier.
 *  - It must be small enough that the escape hatch is rarely needed at all;
 *    5–15 px is the usual DAW range and 8 px sits in the middle of it.
 */
export const SNAP_TOLERANCE_PX = 8;

export interface SnapResult {
  /** The position to use: the winning target when one was within tolerance,
   * otherwise the caller's `sample` unchanged (float preserved — see the
   * integrality note in the module header). */
  sample: number;
  /** The target that won, or `null` when nothing was near enough. */
  target: number | null;
  /** Whether the position was actually moved onto a target. */
  snapped: boolean;
}

function noSnap(sample: number): SnapResult {
  return { sample, target: null, snapped: false };
}

/** Index of the first target at or after `value`, by binary search. Targets are
 * ascending by construction (`mergeTargets` sorts, `beatSamples` is already
 * ascending), which keeps the cost O(log n) on a grid with tens of thousands of
 * beats — this runs on every pointermove of a drag. */
function firstAtOrAfter(targets: ArrayLike<number>, value: number): number {
  let lo = 0;
  let hi = targets.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (targets[mid] < value) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * Quantises `sample` onto the nearest of `targets` within `tolerancePx` screen
 * pixels, or returns it untouched.
 *
 * @param targets ASCENDING sample positions, in the same time base as `sample`.
 *   Never mutated, sorted or copied — callers legitimately pass the analysis
 *   cache's own shared `Int32Array`.
 * @param samplesPerPixel the zoom of the surface the gesture is happening on.
 *   A non-positive or non-finite value produces NO snap: without a scale the
 *   pixel tolerance is undefined, and inventing one is exactly the class of
 *   guess this codebase refuses to make.
 *
 * Tie-break: two targets exactly equidistant resolve to the EARLIER one. The
 * choice is arbitrary but it must be deterministic — a tie that resolved by
 * floating-point luck would make a drag jitter between two beats.
 */
export function snapSample(
  sample: number,
  targets: ArrayLike<number>,
  samplesPerPixel: number,
  tolerancePx: number = SNAP_TOLERANCE_PX
): SnapResult {
  if (!Number.isFinite(sample)) return noSnap(sample);
  if (!Number.isFinite(samplesPerPixel) || samplesPerPixel <= 0) return noSnap(sample);
  if (!Number.isFinite(tolerancePx) || tolerancePx <= 0) return noSnap(sample);
  if (targets.length === 0) return noSnap(sample);

  // THE pixel-space rule. Making this a constant in samples would look right at
  // whatever zoom it was tuned for and be wrong at every other one.
  const toleranceSamples = tolerancePx * samplesPerPixel;

  const i = firstAtOrAfter(targets, sample);
  // Only the two neighbours can win; everything else is further away.
  let best: number | null = null;
  let bestDist = Number.POSITIVE_INFINITY;

  if (i > 0) {
    const left = targets[i - 1];
    const d = sample - left;
    if (d <= toleranceSamples) {
      best = left;
      bestDist = d;
    }
  }
  if (i < targets.length) {
    const right = targets[i];
    const d = right - sample;
    // Strictly less than: an exact tie keeps the earlier (left) target.
    if (d <= toleranceSamples && d < bestDist) {
      best = right;
      bestDist = d;
    }
  }

  if (best === null) return noSnap(sample);
  return { sample: best, target: best, snapped: true };
}

/**
 * The same magnet for a span that moves as a unit — a dragged clip.
 *
 * Both edges are candidates (aligning a clip's TAIL to a beat is as ordinary as
 * aligning its head), and the edge needing the SMALLER correction wins; an
 * exact tie keeps the start edge. Returns the resulting START, so the caller
 * has one number to feed both its preview and its commit.
 *
 * The result may be negative when an end-edge snap would push the span before
 * zero; clamping is the caller's job, because the clamp has to be applied
 * identically to the preview and to the commit (`moveClip` already clamps at
 * `Math.max(0, …)`).
 */
export function snapSpan(
  start: number,
  length: number,
  targets: ArrayLike<number>,
  samplesPerPixel: number,
  tolerancePx: number = SNAP_TOLERANCE_PX
): SnapResult {
  const head = snapSample(start, targets, samplesPerPixel, tolerancePx);
  const tail = snapSample(start + length, targets, samplesPerPixel, tolerancePx);

  if (!tail.snapped) return head;
  const tailStart = tail.sample - length;
  if (!head.snapped) return { sample: tailStart, target: tail.target, snapped: true };

  const headPull = Math.abs(head.sample - start);
  const tailPull = Math.abs(tailStart - start);
  // Strictly less than: an exact tie keeps the start edge.
  if (tailPull < headPull) return { sample: tailStart, target: tail.target, snapped: true };
  return head;
}

/**
 * ---------------------------------------------------------------------------
 * PRIORITY TIERS (W2)
 * ---------------------------------------------------------------------------
 * A flat nearest-wins set has a silent failure mode (the H3 hazard): a dense
 * beat grid almost always owns the sample nearest the pointer, so a beat could
 * beat the session cursor — and, once clip edges became targets, a beat one
 * pixel closer would rob the user of the butt join they were visibly aiming
 * for. The rule that fixes it: HARD GEOMETRY THE USER PLACED (clip edges, the
 * cursor they parked) OUTRANKS DERIVED GEOMETRY (an analysis's beat lines).
 * `tiers` is ordered highest-priority first; the winner is the nearest target
 * within tolerance IN THE HIGHEST TIER THAT HAS ONE, and lower tiers are
 * consulted only when every tier above them has nothing in reach. Within a
 * tier nothing changes: nearest wins, an exact tie keeps the earlier target.
 * Behaviour therefore differs from the flat set ONLY when a higher-tier target
 * is also within tolerance — exactly the case where the user's intent is
 * unambiguous.
 */

/** Priority-ordered target tiers, highest first. Each tier is an ascending
 * array, exactly as `snapSample` expects its `targets`. */
export type SnapTierList = readonly ArrayLike<number>[];

export interface TieredSnapResult extends SnapResult {
  /** Index into the tier list of the tier the winning target came from, or
   * `null` when nothing snapped. */
  tier: number | null;
}

/** `snapSample` with tier priority: nearest-within-tolerance in the highest
 * tier that has a candidate. */
export function snapSampleTiered(
  sample: number,
  tiers: SnapTierList,
  samplesPerPixel: number,
  tolerancePx: number = SNAP_TOLERANCE_PX
): TieredSnapResult {
  for (let t = 0; t < tiers.length; t++) {
    const r = snapSample(sample, tiers[t], samplesPerPixel, tolerancePx);
    if (r.snapped) return { ...r, tier: t };
  }
  return { sample, target: null, snapped: false, tier: null };
}

/**
 * `snapSpan` with tier priority. The head/tail contest (smaller pull wins, tie
 * keeps the head) runs WITHIN each tier; across tiers, priority outranks pull —
 * a head 4 px from a clip edge beats a tail 1 px from a beat, because the edge
 * is what the user is aiming a clip at and the beat merely happens to be dense
 * enough to be nearby.
 */
export function snapSpanTiered(
  start: number,
  length: number,
  tiers: SnapTierList,
  samplesPerPixel: number,
  tolerancePx: number = SNAP_TOLERANCE_PX
): TieredSnapResult {
  for (let t = 0; t < tiers.length; t++) {
    const r = snapSpan(start, length, tiers[t], samplesPerPixel, tolerancePx);
    if (r.snapped) return { ...r, tier: t };
  }
  return { sample: start, target: null, snapped: false, tier: null };
}

/**
 * Combines several target sources into the one ascending, duplicate-free array
 * `snapSample` expects.
 *
 * De-duplication matters: a bar line is by construction one of the beats (the
 * plan's amended ruling 1 — `barBoundary` is exactly the subsequence
 * `beatSamples[downbeatPhase + m·beatsPerBar]`), and a marker is very often
 * dropped exactly on a beat. Duplicates would not change which position wins,
 * but they would make the tie-break's "earlier target" reasoning meaningless
 * and inflate the binary search's array for nothing.
 *
 * Non-finite entries are dropped rather than sorted, since a single `NaN` makes
 * `Array.prototype.sort`'s comparator — and therefore the binary search that
 * relies on the result being ordered — meaningless.
 */
export function mergeTargets(...lists: ArrayLike<number>[]): number[] {
  const all: number[] = [];
  for (const list of lists) {
    for (let i = 0; i < list.length; i++) {
      const v = list[i];
      if (Number.isFinite(v)) all.push(v);
    }
  }
  if (all.length === 0) return [];
  all.sort((a, b) => a - b);
  const out: number[] = [all[0]];
  for (let i = 1; i < all.length; i++) {
    if (all[i] !== out[out.length - 1]) out.push(all[i]);
  }
  return out;
}
