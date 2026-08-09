/**
 * F5 — spatial stereo projection: the pure geometry that turns a source
 * position around the listener (azimuth / elevation / distance) into the
 * inputs of the app's EXISTING stereo pan laws.
 *
 * WHAT THIS IS — AND IS NOT (F5 ruling 3, named honestly). This is AMPLITUDE
 * panning plus distance attenuation — a stereo PROJECTION of a 3D position:
 *
 *  - It is NOT binaural. There is no HRTF convolution, no interaural time
 *    difference, no spectral (pinna / head-shadow) cue. ITD is deliberately
 *    omitted: a time-varying interaural delay is a resampling problem (moving
 *    a delay line produces Doppler-like artefacts unless interpolated), and a
 *    spectral elevation cue would need a time-varying filter whose
 *    coefficients would have to be invented rather than derived. Both are
 *    future backends behind this same interface, not silent approximations.
 *  - Consequently a source BEHIND the listener projects to the same stereo
 *    image as its mirror in front (sin is symmetric about ±90°), and
 *    elevation is audible only as image narrowing (see below). The UI names
 *    the feature for what it does — "stereo projection" — never "3D audio".
 *
 * THE PROJECTION. With azimuth `az` in degrees (0 = front, positive =
 * clockwise from above = toward the RIGHT ear, matching the pan convention
 * where positive pan is R; ±180 = behind) and elevation `el` in degrees
 * (0 = ear level, +90 = zenith, −90 = nadir), the unit direction vector's
 * component along the interaural (left-right) axis is
 *
 *     x = sin(az) · cos(el)   ∈ [−1, 1]
 *
 * and that component IS the equivalent stereo pan position handed to
 * `monoPanGains` / `stereoBalanceGains` (mixdown.ts) — parameter-free
 * geometry, no invented speaker angle. It follows that elevation narrows the
 * image toward centre (cos(±90°) = 0: a source at the zenith is heard dead
 * centre regardless of azimuth) and that hard left/right is reached only at
 * az ±90°, el 0 — both direct consequences of the projection, pinned by
 * spatial.test.ts.
 *
 * DISTANCE follows the Web Audio API's INVERSE distance model with
 * `refDistance = 1` and `rolloffFactor = 1`:
 *
 *     gain = REF / max(REF, distance) = 1 / max(1, d)
 *
 * — unity at or inside the reference distance (no amplification for a source
 * closer than the reference, exactly like `PannerNode`'s clamp), −6 dB at
 * d = 2, −20 dB at d = 10 (the range maximum in `AUTOMATION_RANGES`; a UI
 * bound chosen like volumeDb's −60..+12, giving 0..−20 dB of depth).
 * Distance is unitless — multiples of the reference distance.
 *
 * Pure TS (no DOM, no Electron, no store): importable by both audio engines,
 * the automation model and the UI, and safe inside a Web Worker.
 */

/** The reference distance of the inverse-distance law: gains are unity at or
 * inside it. Also the NEUTRAL distance (`SPATIAL_NEUTRAL`). */
export const SPATIAL_REF_DISTANCE = 1;

/** The position an ABSENT spatial lane means, per parameter: dead ahead at
 * ear level, on the reference circle — the neutral point where the projection
 * is exactly centre at unity gain. Shared by the engines' lane-absent
 * defaults (`autoSpatialGainsAt`) and the UI's zero-key envelope line, so the
 * two can never disagree about what "no keys" sounds like. */
export const SPATIAL_NEUTRAL = { azimuth: 0, elevation: 0, distance: SPATIAL_REF_DISTANCE } as const;

const DEG = Math.PI / 180;

/**
 * The equivalent stereo pan position of a source at (azimuth°, elevation°):
 * `sin(az)·cos(el)`, the direction vector's interaural-axis component (see
 * the module note). Always in [−1, 1] for finite inputs (|sin·cos| <= 1), so
 * the result feeds the pan laws directly with no clamp.
 */
export function spatialPanPosition(azimuthDeg: number, elevationDeg: number): number {
  return Math.sin(azimuthDeg * DEG) * Math.cos(elevationDeg * DEG);
}

/**
 * The distance attenuation at `distance` (unitless, multiples of the
 * reference): the Web Audio inverse distance model at refDistance 1 /
 * rolloff 1 — `1 / max(1, d)`. Exactly 1 for every d <= 1 (identical to
 * `PannerNode`'s below-reference clamp), monotonically falling above it.
 */
export function spatialDistanceGain(distance: number): number {
  return SPATIAL_REF_DISTANCE / Math.max(SPATIAL_REF_DISTANCE, distance);
}
