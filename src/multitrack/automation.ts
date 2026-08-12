import { FADE_CURVES, fadeInShape, type FadeCurve } from '../dsp/fades';

/**
 * F0 — automation keys: timeline envelopes for track parameters.
 *
 * THE MODEL. One optional lane per (track, parameter): an ordered list of
 * keys, each `{ positionSample, value, curve }`, where `curve` describes the
 * interpolation FROM this key TO the next (absent = `DEFAULT_AUTOMATION_CURVE`,
 * the fade-key convention: nothing may distinguish `undefined` from a missing
 * key). Positions are SESSION-timeline samples (integers >= 0, unique within a
 * lane, kept ascending). Values are in the parameter's own unit — dB for
 * `volumeDb` (−60..+12, so ramps interpolate linearly IN dB, the musical
 * behaviour), pan position for `pan` (−1..1).
 *
 * OVERRIDE, NOT OFFSET (ruling B). While a lane has >= 1 key, the lane IS the
 * parameter: both audio engines evaluate the lane and ignore the static Track
 * field entirely, and the live node that used to carry the static value is
 * neutralised to unity. A user who draws a volume envelope means *that* to be
 * the volume, not a trim on top of a fader. A lane with ZERO keys must be
 * indistinguishable from no lane at all — `resolveAutomation` returns the same
 * `null` for both, so the static field governs and every pre-automation code
 * path is taken unchanged.
 *
 * ABSENT MEANS NONE (traps T9/T11). `Track.automation` is never initialised by
 * `createTrack`, an emptied lane is removed, and a track whose last lane is
 * removed loses the field entirely — which is what keeps a session that never
 * touched automation byte-identical on disk to what v1.9.2 wrote
 * (`JSON.stringify` drops absent keys; the byte-identity pin in
 * `sessionFile.test.ts` hard-codes the v1.8.0 track key order).
 *
 * Pure TS: no DOM, no store, no Electron — importable by both audio engines,
 * the parse boundary and the UI.
 */

/** The parameters a track lane can automate. F0 (v1.10) shipped `volumeDb`
 * and `pan`; F5 (v1.11) extends the union — the designed extension point —
 * with the spatial position: `azimuth` (degrees, 0 = front, positive =
 * toward the RIGHT ear, ±180 = behind — the pan sign convention), `elevation`
 * (degrees, 0 = ear level, +90 = zenith) and `distance` (unitless multiples
 * of the reference distance — see `dsp/spatial.ts` for the projection these
 * feed). Still deliberately bounded: track parameters only — not clip gain,
 * not effect parameters, not sends. */
export type AutomationParam = 'volumeDb' | 'pan' | 'azimuth' | 'elevation' | 'distance';

/** Every automatable parameter, for runtime membership checks (the
 * `FADE_CURVES.includes` precedent — the type doesn't protect a JS caller). */
export const AUTOMATION_PARAMS: readonly AutomationParam[] = [
  'volumeDb',
  'pan',
  'azimuth',
  'elevation',
  'distance',
];

/** UI display names, one per parameter (the `FADE_CURVE_LABELS` precedent —
 * a single source so panels and lanes cannot drift). */
export const AUTOMATION_PARAM_LABELS: Record<AutomationParam, string> = {
  volumeDb: 'Volume',
  pan: 'Pan',
  azimuth: 'Azimuth',
  elevation: 'Elevation',
  distance: 'Distance',
};

/** One automation key. `curve` shapes the segment from THIS key to the NEXT
 * key (a trailing key's curve is inert until a later key exists); absent means
 * `DEFAULT_AUTOMATION_CURVE`, and nothing may distinguish absent from
 * `undefined` (the fade-key persistence convention). */
export interface AutomationKey {
  /** Session-timeline sample (integer >= 0; unique within its lane). */
  positionSample: number;
  /** Parameter value AT this key, in the parameter's unit (dB / pan). */
  value: number;
  /** Interpolation from this key to the next; absent = default. */
  curve?: FadeCurve;
}

/** One track parameter's envelope. Kept ascending by `positionSample` with
 * unique positions — an invariant established by the store actions
 * (`upsertAutomationKey`) and re-established against untrusted files at the
 * parse boundary (`sanitizeAutomationLanes`); `automationValueAt`'s binary
 * search relies on it. Every mutation produces a FRESH array (trap T16: the
 * lane array is shared across renders and engine calls). */
export interface AutomationLane {
  param: AutomationParam;
  keys: AutomationKey[];
}

/** The curve an absent key `curve` means. `'equal-gain'` — a straight-line
 * ramp — because a single-parameter automation segment is a SOLO shape, not a
 * crossfade: the level-holding argument that makes `'equal-power'` the right
 * default for facing clip fades (two signals summing) does not apply to one
 * parameter moving between two values, and a straight segment between keys is
 * what every drawn envelope means by default. */
export const DEFAULT_AUTOMATION_CURVE: FadeCurve = 'equal-gain';

/** Each parameter's legal value range — THE single source for the clamp below
 * and for the UI's value↔pixel mapping. volumeDb/pan are the Track field
 * ranges (`session.ts`): −60..+12 dB, −1..1. The spatial ranges: azimuth
 * ±180° (the full circle; both endpoints are the same direction — see the
 * circular interpolation note on `automationValueAt`), elevation ±90°
 * (nadir..zenith), distance 0..10 — 10 × the reference distance is −20 dB
 * under the inverse law (`dsp/spatial.ts`), a chosen UI depth bound exactly
 * like volumeDb's −60 floor. */
export const AUTOMATION_RANGES: Record<AutomationParam, { min: number; max: number }> = {
  volumeDb: { min: -60, max: 12 },
  pan: { min: -1, max: 1 },
  azimuth: { min: -180, max: 180 },
  elevation: { min: -90, max: 90 },
  distance: { min: 0, max: 10 },
};

/** Clamps a key value to its parameter's legal range — THE value-range
 * arithmetic, shared by the store action (`upsertAutomationKey`), the parse
 * boundary (`sanitizeAutomationLanes`) and the envelope gesture's preview
 * (the `clampFadePair` pattern, T15). Inputs must be finite (callers own
 * NaN/type guarding). */
export function clampAutomationValue(param: AutomationParam, value: number): number {
  const r = AUTOMATION_RANGES[param];
  return Math.min(r.max, Math.max(r.min, value));
}

/** Index of the LAST key at or before `sample` (-1 when `sample` precedes the
 * first key) — the segment-start lookup. Binary search over the ascending
 * `positionSample` order; `snap.ts`'s `firstAtOrAfter` idiom, inverted (the
 * same lower-bound loop, returning `lo - 1`). */
function lastAtOrBefore(keys: readonly AutomationKey[], sample: number): number {
  let lo = 0;
  let hi = keys.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (keys[mid].positionSample <= sample) lo = mid + 1;
    else hi = mid;
  }
  return lo - 1;
}

/**
 * F5 — the short-arc wrap of an azimuth DELTA into [−180, 180): the signed
 * degrees actually travelled between two azimuth keys. Interpolating a lane
 * across ±180 takes the SHORT way round — two keys at 170° and −170° mean a
 * 20° pass behind the listener, not a 340° sweep back through the front: the
 * keys describe a motion, and the shortest arc is the least-surprise
 * continuation (a deliberate long sweep is expressed by adding an
 * intermediate key, which the short-arc rule then honours segment by
 * segment). ANTIPODAL keys (delta exactly ±180 — both arcs equal) travel the
 * DECREASING-azimuth arc, through the listener's LEFT: `−180`, the value the
 * plain mod formula produces for both signs, kept as the deterministic
 * tie-break and pinned by test. In-range deltas return bit-exact (no mod
 * round-trip).
 */
export function wrapAzimuthDelta(d: number): number {
  if (d > -180 && d < 180) return d;
  return ((((d + 180) % 360) + 360) % 360) - 180;
}

/** F5 — re-wraps an interpolated azimuth VALUE into [−180, 180]. Values
 * already in range — every key value, by the range clamp — return BIT-EXACT
 * (both endpoints included: a key may hold +180, and +180 must come back as
 * +180, not −180; the two label the same direction, so audio cannot tell,
 * but the evaluator's exact-on-key contract can). Only a mid-segment value
 * carried past the seam by the short arc (range ±360 by construction) takes
 * the mod formula, which lands in [−180, 180). */
export function wrapAzimuth(v: number): number {
  if (v >= -180 && v <= 180) return v;
  return ((((v + 180) % 360) + 360) % 360) - 180;
}

/**
 * THE evaluator: the parameter's value at timeline sample `sample` — one pure
 * function serving BOTH audio engines (ruling A / trap T5: two evaluators
 * would disagree at segment boundaries and in the hold regions), the UI's
 * envelope drawing, and every test anchor.
 *
 * Semantics:
 *  - BEFORE the first key and AFTER the last key the nearest key's value is
 *    HELD (never extrapolated — extrapolation invents values the user never
 *    set). A one-key lane therefore holds its value over the whole timeline.
 *  - BETWEEN key k and key k+1 the value interpolates from `k.value` to
 *    `k+1.value` along `k.curve` via the shared `fades.ts` shape family:
 *    `v0 + (v1 − v0) · fadeInShape(u, curve)` with
 *    `u = (sample − p0) / (p1 − p0)`. `fadeInShape` is the SOLO ramp shape —
 *    never `crossfadeGains`, whose `1/k` normalisation is a pair law and is
 *    simply wrong applied to one parameter (trap T7).
 *  - A sample exactly ON a key returns that key's `value` EXACTLY (the key is
 *    the segment START, `u = 0`, and `fadeInShape(0) = 0` for every curve, so
 *    the arithmetic collapses to `v0 + (v1 − v0) · 0` — no floating-point
 *    round-trip can move it).
 *
 * F5 — CIRCULAR PARAMETER: when `param` is `'azimuth'` the value domain is a
 * circle and segments interpolate along the SHORT arc,
 * `wrapAzimuth(v0 + wrapAzimuthDelta(v1 − v0) · shape(u))` — see the two
 * helpers above for the arc choice, the antipodal tie-break and the exactness
 * guarantees (hold regions and on-key samples still return the stored value
 * bit-exact; only mid-segment values can wrap). Every OTHER param
 * interpolates linearly exactly as F0 shipped. `param` is REQUIRED (review
 * round 1): the evaluator cannot know a lane is circular unless told, and an
 * optional param would let a future caller evaluate an azimuth lane linearly
 * by silent omission — making it mandatory turns that mistake into an
 * affirmative wrong choice the call site has to write down. Both audio
 * engines route through `autoSpatialGainsAt` (mixdown.ts) and the envelope
 * UI passes its lane's param — the single-evaluator discipline (T5) with the
 * wrap decided in exactly one place.
 *
 * `keys` must be non-empty and ascending by `positionSample` (the lane
 * invariant). Callers gate emptiness through `resolveAutomation`.
 */
export function automationValueAt(
  keys: readonly AutomationKey[],
  sample: number,
  param: AutomationParam
): number {
  const i = lastAtOrBefore(keys, sample);
  if (i < 0) return keys[0].value; // hold before the first key
  if (i >= keys.length - 1) return keys[keys.length - 1].value; // hold after the last
  const a = keys[i];
  const b = keys[i + 1];
  const u = (sample - a.positionSample) / (b.positionSample - a.positionSample);
  const shape = fadeInShape(u, a.curve ?? DEFAULT_AUTOMATION_CURVE);
  if (param === 'azimuth') {
    return wrapAzimuth(a.value + wrapAzimuthDelta(b.value - a.value) * shape);
  }
  return a.value + (b.value - a.value) * shape;
}

/** F5 — the spatial lanes as a resolved group: each of the three key lists,
 * `null` when that lane is absent or has zero keys. The GROUP exists (the
 * spec's `spatial` is non-null) as soon as ANY of the three is active; a
 * missing member then evaluates at its `SPATIAL_NEUTRAL` value inside
 * `autoSpatialGainsAt` (dead ahead / ear level / reference distance). */
export interface SpatialAutomationSpec {
  azimuth: readonly AutomationKey[] | null;
  elevation: readonly AutomationKey[] | null;
  distance: readonly AutomationKey[] | null;
}

/** A track's ACTIVE automation, resolved once per render pass: the volume and
 * pan key lists — `null` per parameter when that lane is absent OR has zero
 * keys — plus the F5 spatial group. The whole spec is `null` when nothing is
 * active — the shared has-automation test both engines gate on (the
 * `resolveClipFadeSpecs` Map pattern), which is what keeps a lane-less track
 * on the pristine static code path, byte-identical to v1.9.2.
 *
 * F5 RULING 4 — WHILE `spatial` IS NON-NULL, `pan` IS SUPERSEDED. The spatial
 * projection and the pan parameter compute the same thing — the track's
 * stereo placement — and two placement laws composed would double-apply
 * position (the exact reasoning of F0's override-not-offset ruling B, one
 * level up: the more specific placement system IS the placement). So while
 * any spatial lane has a key, BOTH engines take their channel gains from
 * `autoSpatialGainsAt` and ignore the pan lane AND the static `Track.pan`
 * entirely; `pan` here stays whatever its lane resolves to, but consumers
 * must consult `spatial` FIRST (both engines and the header UI do — pinned
 * by the supersession tests). A track with NO spatial lane behaves exactly
 * as F0 shipped it, byte-identical (v1.10.0's ruling 10, re-pinned for F5). */
export interface TrackAutomationSpec {
  volume: readonly AutomationKey[] | null;
  pan: readonly AutomationKey[] | null;
  spatial: SpatialAutomationSpec | null;
}

/**
 * Resolves a track's lanes to the active spec, or `null` when no lane has any
 * keys (zero-key lane === no lane === absent field, by construction). On a
 * hostile duplicate-param lane list the LAST lane wins — the same rule the
 * parse-boundary sanitizer applies, so the two can never disagree (well-formed
 * data has at most one lane per param and never hits the case).
 */
export function resolveAutomation(
  lanes: readonly AutomationLane[] | undefined
): TrackAutomationSpec | null {
  if (!lanes || lanes.length === 0) return null;
  let volume: readonly AutomationKey[] | null = null;
  let pan: readonly AutomationKey[] | null = null;
  let azimuth: readonly AutomationKey[] | null = null;
  let elevation: readonly AutomationKey[] | null = null;
  let distance: readonly AutomationKey[] | null = null;
  for (const lane of lanes) {
    if (lane.keys.length === 0) continue; // zero keys: indistinguishable from no lane
    if (lane.param === 'volumeDb') volume = lane.keys;
    else if (lane.param === 'pan') pan = lane.keys;
    else if (lane.param === 'azimuth') azimuth = lane.keys;
    else if (lane.param === 'elevation') elevation = lane.keys;
    else if (lane.param === 'distance') distance = lane.keys;
  }
  const spatial: SpatialAutomationSpec | null =
    azimuth !== null || elevation !== null || distance !== null
      ? { azimuth, elevation, distance }
      : null;
  if (volume === null && pan === null && spatial === null) return null;
  return { volume, pan, spatial };
}

/**
 * Re-establishes the lane invariant against an UNTRUSTED value (a hand-edited
 * or foreign `.audm`'s `automation` field) — the automation counterpart of
 * `sanitizeClipFades`, kept here as pure arithmetic so `sessionFile.ts` calls
 * it from `finalizeParsedSession` (both the v3 and the legacy parse paths,
 * trap T12) without owning the rules:
 *  - not an array (or nothing survives): `undefined` — the field is REMOVED,
 *    so garbage round-trips back to "no key on disk" (the fade precedent);
 *  - a lane whose `param` is not in `AUTOMATION_PARAMS`, or whose `keys` is
 *    not an array, is dropped; duplicate lanes for one param: LAST wins
 *    (matching `resolveAutomation`);
 *  - a key whose `positionSample` or `value` is not a finite number is
 *    dropped; positions are rounded and clamped >= 0, values clamped to the
 *    param range, an unknown `curve` string is dropped (absent = default);
 *  - keys are sorted ascending and de-duplicated by position (LAST occurrence
 *    wins — the store's replace-on-occupied-position semantic);
 *  - a lane left with zero keys is dropped entirely.
 * Every returned array is fresh — nothing aliases the parsed JSON.
 */
export function sanitizeAutomationLanes(raw: unknown): AutomationLane[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const byParam = new Map<AutomationParam, AutomationKey[]>();
  for (const lane of raw) {
    if (lane === null || typeof lane !== 'object') continue;
    const param = (lane as { param?: unknown }).param;
    if (typeof param !== 'string' || !(AUTOMATION_PARAMS as readonly string[]).includes(param)) continue;
    const rawKeys = (lane as { keys?: unknown }).keys;
    if (!Array.isArray(rawKeys)) continue;

    const cleaned: AutomationKey[] = [];
    for (const k of rawKeys) {
      if (k === null || typeof k !== 'object') continue;
      const pos = (k as { positionSample?: unknown }).positionSample;
      const value = (k as { value?: unknown }).value;
      if (typeof pos !== 'number' || !Number.isFinite(pos)) continue;
      if (typeof value !== 'number' || !Number.isFinite(value)) continue;
      const curveRaw = (k as { curve?: unknown }).curve;
      const key: AutomationKey = {
        positionSample: Math.max(0, Math.round(pos)),
        value: clampAutomationValue(param as AutomationParam, value),
      };
      if (typeof curveRaw === 'string' && (FADE_CURVES as readonly string[]).includes(curveRaw)) {
        key.curve = curveRaw as FadeCurve;
      }
      cleaned.push(key);
    }
    if (cleaned.length === 0) continue;

    cleaned.sort((a, b) => a.positionSample - b.positionSample); // stable: file order kept within ties
    const unique: AutomationKey[] = [];
    for (const k of cleaned) {
      if (unique.length > 0 && unique[unique.length - 1].positionSample === k.positionSample) {
        unique[unique.length - 1] = k; // duplicate position: last occurrence wins
      } else {
        unique.push(k);
      }
    }
    byParam.set(param as AutomationParam, unique); // duplicate lane: last wins
  }
  if (byParam.size === 0) return undefined;
  return [...byParam.entries()].map(([param, keys]) => ({ param, keys }));
}
