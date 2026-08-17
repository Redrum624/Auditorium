/**
 * Task F9 — vocal timing alignment: warp a sung take so its syllables land on
 * the beat when the singer drags or rushes.
 *
 * Match Tempo cannot do this — not even in the follow-the-beats mode R7 added,
 * and the distinction is worth stating precisely because the two features now
 * look similar. Follow-the-beats warps by the TRACKED BEATS OF THE MATERIAL:
 * it puts the beats where the target grid wants them. This module warps by
 * SYLLABLES THE USER MARKED. A singer who drags one line and rushes the next is
 * off relative to beats that are already in the right place, so a tempo map
 * moves the beats she is late against and leaves her just as late. Use
 * follow-the-beats when the music's tempo moves; use this when the singer moves
 * against a tempo that does not.
 *
 * The engine both share is `timeStretchVariableLinked` (`wsola.ts`), built for
 * F1's Pitch Correct: variable-rate, stereo-linked, pitch-preserving stretching
 * from a caller-supplied time map. This module supplies the map.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS MODULE IS AND IS NOT
 * ---------------------------------------------------------------------------
 * It is three pure functions:
 *  - {@link detectVocalOnsets} — spectral-flux onset candidates for a voice.
 *    **PROPOSALS ONLY.** See the measured reliability below; nothing here is
 *    accurate enough to move audio without a human confirming each anchor.
 *  - {@link buildWarpMap} — anchors -> a monotonic, ratio-bounded time map.
 *  - {@link applyTimingWarp} — that map + `timeStretchVariableLinked`.
 *
 * It is NOT a stretcher, NOT a beat tracker (`tempoCore.ts` does that) and NOT
 * a grid chooser (the user chooses; see RULING 1 below).
 *
 * ---------------------------------------------------------------------------
 * RULING 3, MEASURED: spectral flux is NOT reliable enough to drive this alone
 * ---------------------------------------------------------------------------
 * `onsetEnvelope`'s tempo-detection parameters were measured against 23
 * hand-marked note attacks in an 8 s excerpt (17.4–25.4 s) of a real 142 s solo
 * cover vocal, `test-assets/long-real-take.wav`. Peak-picking swept over its
 * threshold, scored at the two tolerances that matter for timing work:
 *
 * | analysis parameters                    | best F1 @±50 ms | precision | recall | median \|error\| |
 * |----------------------------------------|-----------------|-----------|--------|------------------|
 * | as tempo detection runs it (11 kHz)    | 0.65            | 0.56      | 0.78   | 36 ms            |
 * | 24 kHz, 10.7 ms hop                    | 0.74            | 0.80      | 0.70   | 32 ms            |
 * | **48 kHz, no decimation, 5.3 ms hop**  | **0.75**        | **0.88**  | 0.65   | **12 ms**        |
 *
 * At the ±30 ms tolerance timing correction actually needs, the best of the
 * three reaches F1 0.57. The parameters do **not** transfer from percussive
 * tempo detection to a legato vocal: as shipped, **44 % of reported onsets are
 * not note attacks** — they are breaths, note *endings*, portamento slides and
 * vibrato peaks. Every one of those is a syllable-sized span that an automatic
 * mode would drag onto a beat it never belonged on, manufacturing a timing
 * error where none existed. And each "best" threshold above was chosen on the
 * same 8 s it was scored on, so those are optimistic in-sample numbers.
 *
 * The retuned parameterisation (no decimation) is what {@link detectVocalOnsets}
 * uses, because 0.88 precision and 12 ms localisation make a *proposal* worth
 * looking at. It is still one bad anchor in eight. **The caller must confirm
 * every anchor before any audio is stretched.**
 *
 * Ground-truth protocol, stated so it can be criticised: attacks were marked by
 * eye from a 0.625 ms/px plot of the 48 kHz waveform, its 10 ms RMS envelope
 * and its >3.5 kHz sibilance envelope, cross-checked against F1's YIN pitch
 * track (a note change is a voicing restart or a pitch step; a portamento or a
 * vibrato dip is not), then each accepted attack's time was computed
 * mechanically as the envelope minimum in the 60 ms before the rise peak. The
 * marker could not LISTEN to the audio, so a purely legato note change with
 * neither an amplitude nor a pitch cue is absent from the ground truth — which
 * can only inflate the recall figures above, never deflate them.
 *
 * ---------------------------------------------------------------------------
 * RULING 1: the grid is the user's call, and this module never guesses it
 * ---------------------------------------------------------------------------
 * Tempo detection on the user's own material put the drums stem at 159.83 BPM
 * and the five non-drum sources at a mean of 109.4 (max deviation 4.9) — a ~3:2
 * split that is a property of the music, with every confidence between 0.003
 * and 0.084 against `CONFIDENCE_LOW = 0.35`. Both grids are musically
 * defensible, so an automatic pick is a coin flip that makes every correction
 * 2/3 or 1.5x wrong. This module therefore takes **anchors**, never a tempo:
 * choosing the grid, the subdivision and which syllables move is the caller's
 * job, and `AlignTimingDialog` makes the user confirm it.
 *
 * The subdivision matters as much as the tempo, and that is measured too. The
 * 23 marked attacks fitted against a 109.4 BPM grid (best phase) sit a median
 * of **120 ms** from the nearest quarter note, **63 ms** from the nearest
 * eighth, and **25 ms** from the nearest sixteenth. The performance is on
 * sixteenths with ~31 ms rms of human micro-timing; snapping it to quarters
 * would move syllables by up to 260 ms and destroy the take.
 */

import { ONSET_FFT, ONSET_HOP, onsetEnvelope } from './tempoCore';
import { MAX_RATIO, MIN_RATIO, timeStretchVariableLinked } from './wsola';

// ---------------------------------------------------------------------------
// Bounds and defaults — every one derived, none chosen by taste
// ---------------------------------------------------------------------------

/**
 * The warp's local time-scale ratio is clamped to `[MIN_LOCAL_RATIO,
 * MAX_LOCAL_RATIO]`. These are NOT `wsola.ts`'s `MIN_RATIO`/`MAX_RATIO` (0.25 /
 * 4) — those are the engine's limits, far past anything musical. They are the
 * repo's OWN transparency band: `tempoService.ts`'s
 * `QUALITY_TRANSPARENT_MIN_RATIO` / `QUALITY_TRANSPARENT_MAX_RATIO`, already
 * ruled (T7) to be the range within which this WSOLA is transparent, with
 * "slight transient smearing" beyond it.
 *
 * Timing alignment stretches *sung vowels*, and the whole premise of the
 * feature is that the result must not sound processed, so the transparent band
 * is exactly the right bound. They are duplicated here rather than imported
 * because DSP must stay free of `src/services` (which imports the store);
 * `timingWarp.test.ts` asserts the two pairs are equal so they cannot drift.
 */
export const MIN_LOCAL_RATIO = 0.88;
export const MAX_LOCAL_RATIO = 1.14;

/**
 * Default correction strength — deliberately well below 100 %, and derived
 * from measurement rather than taste.
 *
 * Fully quantising a vocal sounds robotic, but "so use less" is not a
 * derivation. This one comes from the interaction between the measured
 * material and the bound above. Applying strength `s` to the 23 marked attacks
 * of the real vocal, using the REAL differential (adjacent anchors move too,
 * so a span changes by the difference of two corrections, not by one), the
 * number of the 22 inter-anchor spans whose local ratio leaves the transparent
 * band is:
 *
 * | strength | on the eighth grid | on the sixteenth grid |
 * |----------|--------------------|-----------------------|
 * | **0.25** | **0 / 22**         | **0 / 22**            |
 * | 0.50     | 5 / 22             | 3 / 22                |
 * | 0.75     | 8 / 22             | 5 / 22                |
 * | 1.00     | 12 / 22            | 9 / 22                |
 *
 * 0.25 is the largest strength at which *no* span on either musically
 * plausible subdivision needs a ratio outside the band — the worst it induces
 * is 0.888 against a 0.88 floor, so it is genuinely the boundary and not a
 * round number. A 100 % default would push 41–55 % of the spans into the clamp,
 * i.e. it would spend half its time doing something other than what it says.
 *
 * This is a DEFAULT, not a cap. The user can raise it, and the dialog reports
 * how many spans the bound had to hold back when they do.
 */
export const DEFAULT_STRENGTH = 0.25;

/**
 * Minimum spacing between accepted onset candidates. The shortest gap between
 * two hand-marked attacks in the measured excerpt is 211 ms; 100 ms is well
 * inside that while still being longer than the 5.3 ms analysis hop, so it
 * suppresses the multi-frame ringing around one attack without ever merging two
 * real syllables. (A sixteenth note at the material's 109.4 BPM is 137 ms.)
 */
export const ONSET_MIN_SPACING_SEC = 0.1;

/**
 * Peak-picker threshold: a frame is an onset when it exceeds the mean of its
 * local neighbourhood by this much. 2.5 is where the swept sensitivity curve
 * put the best F1 (0.75) and the best precision (0.88) for the no-decimation
 * parameterisation — see the module header's table. Exposed through
 * {@link OnsetOptions.sensitivity} so the caller can trade recall for
 * precision; the reported strengths let the caller re-threshold without
 * re-running the FFT.
 */
export const DEFAULT_ONSET_THRESHOLD = 2.5;

/** Peak-picker neighbourhood half-widths, in ODF frames: a candidate must be
 * the local maximum over ±`PEAK_RADIUS` and beat the mean over ±`MEAN_RADIUS`.
 * The values the measurement swept with. Exported so
 * {@link pickOnsetFrames}'s neighbourhood behaviour can be probed at the
 * boundary rather than at an arbitrary radius. */
export const PEAK_RADIUS = 3;
export const MEAN_RADIUS = 10;

// ---------------------------------------------------------------------------
// Onset detection
// ---------------------------------------------------------------------------

export interface OnsetOptions {
  /** Peak-picker threshold; see {@link DEFAULT_ONSET_THRESHOLD}. Lower finds
   * more (and more wrong) onsets. */
  sensitivity?: number;
  /** Minimum gap between accepted onsets, seconds. See
   * {@link ONSET_MIN_SPACING_SEC}. */
  minSpacingSec?: number;
}

/**
 * The peak picker, over a bare onset-detection function.
 *
 * Split out of {@link detectVocalOnsets} so its three comparisons — the
 * neighbourhood maximum, the threshold on the excess over the local mean, and
 * the minimum spacing — can each be probed at their boundary on a hand-written
 * ODF, where the boundary is visible. Driving them through a real audio fixture
 * pins that the picker exists; it does not pin its radii, and a mutation sweep
 * confirmed it does not (PEAK_RADIUS 3 -> 1 and MEAN_RADIUS 10 -> 2 both
 * survived a full audio-level suite).
 *
 * Frames outside `[firstFrame, lastFrame]` are never considered — see
 * {@link detectVocalOnsets} for why the envelope's edge frames are excluded
 * rather than thresholded. A frame ties with a neighbour (`odf[k] === odf[t]`)
 * is still a peak; only a STRICTLY greater neighbour rejects it, so a flat
 * maximum yields its earliest frame rather than none.
 */
export function pickOnsetFrames(
  odf: ArrayLike<number>,
  firstFrame: number,
  lastFrame: number,
  opts: { peakRadius: number; meanRadius: number; threshold: number; minSpacingFrames: number }
): { frames: number[]; strengths: number[] } {
  const { peakRadius, meanRadius, threshold, minSpacingFrames } = opts;
  const n = odf.length;
  const frames: number[] = [];
  const strengths: number[] = [];
  let lastAccepted = -Infinity;

  const from = Math.max(0, firstFrame);
  const to = Math.min(n - 1, lastFrame);

  for (let t = from; t <= to; t++) {
    const v = odf[t];

    let isPeak = true;
    const pLo = Math.max(0, t - peakRadius);
    const pHi = Math.min(n - 1, t + peakRadius);
    for (let k = pLo; k <= pHi; k++) {
      if (odf[k] > v) {
        isPeak = false;
        break;
      }
    }
    if (!isPeak) continue;

    let sum = 0;
    let count = 0;
    const mLo = Math.max(0, t - meanRadius);
    const mHi = Math.min(n - 1, t + meanRadius);
    for (let k = mLo; k <= mHi; k++) {
      sum += odf[k];
      count++;
    }
    const excess = v - sum / count;
    if (excess < threshold) continue;

    if (t - lastAccepted < minSpacingFrames) continue;
    lastAccepted = t;

    frames.push(t);
    strengths.push(excess);
  }

  return { frames, strengths };
}

export interface OnsetResult {
  /** Accepted onset positions in samples of the input's rate, ascending. */
  samples: Int32Array;
  /** Per-onset flux excess over the local mean — the number the threshold was
   * applied to. Bigger is more confident, but see the module header: even the
   * strongest are proposals. Parallel to {@link samples}. */
  strengths: Float32Array;
  /** Spacing of the underlying onset envelope, Hz. The localisation floor is
   * half a hop, so this is the best accuracy any onset here can have. */
  odfRate: number;
}

/**
 * Spectral-flux onset candidates for a sung vocal.
 *
 * Runs `onsetEnvelope` at the input's OWN rate — no `decimateMono` — because
 * that is what measured best (see the module header): decimating to ~11 kHz
 * costs 3x in localisation (36 ms vs 12 ms median error) and drops precision
 * from 0.88 to 0.56, since it puts the ODF hop at 21 ms and throws away the
 * sibilant and plosive energy that marks a syllable in a voice. The frame
 * geometry is `onsetEnvelope`'s fixed `ONSET_FFT`/`ONSET_HOP` in samples, so
 * the analysis hop is `ONSET_HOP / sampleRate` — 5.3 ms at 48 kHz, 5.8 ms at
 * 44.1 kHz. That rate dependence is real and is reported as
 * {@link OnsetResult.odfRate}; it is not normalised away because doing so
 * would mean resampling the whole take to buy consistency in a number the
 * caller is told anyway.
 *
 * Frame -> sample uses `tempoCore.ts`'s ODF FRAME ATTRIBUTION CONTRACT,
 * `attackSample = (f + 1) * ONSET_HOP` (the decimation factor is 1 here). Using
 * `f * ONSET_HOP` would read every attack one hop early.
 *
 * Never mutates `mono`. Returns empty arrays for input shorter than one FFT
 * frame — there is no envelope to pick peaks from, and inventing one would
 * hand the caller anchors it could not have earned.
 */
export function detectVocalOnsets(
  mono: Float32Array,
  sampleRate: number,
  opts: OnsetOptions = {}
): OnsetResult {
  const sensitivity = opts.sensitivity ?? DEFAULT_ONSET_THRESHOLD;
  const minSpacingSec = opts.minSpacingSec ?? ONSET_MIN_SPACING_SEC;
  const odfRate = sampleRate / ONSET_HOP;

  // No short-input early return: the edge guard below already makes
  // `firstFrame > lastUsableFrame` for every input shorter than `ONSET_FFT`
  // (`ceil(512/256) = 2 > floor((len-512)/256)` whenever `len < 1024`), so a
  // separate guard would be a branch no test could ever kill.
  const { odf, numFrames } = onsetEnvelope(mono, sampleRate);
  const minSpacingFrames = Math.max(1, Math.round(minSpacingSec * odfRate));

  // Frames whose window runs off either end of the signal are zero-padded
  // (`onsetEnvelope` centres its window at `t*ONSET_HOP`), and a tone sliding
  // out of a Hann window broadens spectrally — which reads as positive flux in
  // the bands away from the tone. A steady 220 Hz sine therefore produces a
  // spurious "onset" at its final frame with no edge guard at all (measured).
  // That flux is a property of the padding, not of the audio, so those frames
  // are excluded rather than thresholded: no threshold can tell the two apart.
  const half = ONSET_FFT / 2;
  const firstFrame = Math.ceil(half / ONSET_HOP);
  const lastUsableFrame = Math.floor((mono.length - half) / ONSET_HOP);

  const { frames, strengths } = pickOnsetFrames(
    odf.subarray(0, numFrames),
    firstFrame,
    lastUsableFrame,
    {
      peakRadius: PEAK_RADIUS,
      meanRadius: MEAN_RADIUS,
      threshold: sensitivity,
      minSpacingFrames,
    }
  );

  // ODF FRAME ATTRIBUTION CONTRACT (tempoCore.ts): the flux peak for an attack
  // at sample k*ONSET_HOP lands in frame k-1, so the attack is at
  // (f+1)*ONSET_HOP. No clamp is needed — the edge guard already caps `t` at
  // `(len - ONSET_FFT/2)/ONSET_HOP`, so the position cannot exceed
  // `len - ONSET_FFT/2 + ONSET_HOP`, inside the signal for `ONSET_FFT >
  // 2*ONSET_HOP`.
  const samples = frames.map((t) => (t + 1) * ONSET_HOP);

  return { samples: Int32Array.from(samples), strengths: Float32Array.from(strengths), odfRate };
}

// ---------------------------------------------------------------------------
// Grid subdivision
// ---------------------------------------------------------------------------

/**
 * Expands tracked beat positions into a grid of `division` points per beat
 * (1 = the beats themselves, 2 = eighths, 4 = sixteenths at 4/4).
 *
 * Subdivides BETWEEN consecutive tracked beats by linear interpolation rather
 * than laying a rigid `60/bpm` grid, because `beatSamples` are real tracked
 * positions that follow a drifting take (`beatGrid.ts`) — a rigid subdivision
 * would drift away from them between beats and re-introduce exactly the error
 * this feature exists to remove. There is no extrapolation past the last
 * tracked beat: the analysis measured no beats there, so neither does this.
 *
 * Returns ascending, de-duplicated positions. `division < 1`, a non-integer
 * division, or fewer than two beats returns a copy of the beats unchanged.
 */
export function subdivideBeats(beatSamples: ArrayLike<number>, division: number): Int32Array {
  const n = beatSamples.length;
  if (n === 0) return new Int32Array(0);

  // A non-integer or sub-1 division is normalised to 1 — the beats themselves —
  // rather than special-cased into a separate copy path. `division = 1` runs
  // through the general loop unchanged (`d < 1` emits only the beat), so there
  // is one code path and no branch a test cannot reach. Refusing 1.5 rather
  // than honouring it is deliberate: two-thirds of a beat is not a grid the
  // caller can have meant.
  const div = Number.isInteger(division) && division >= 1 ? division : 1;

  // `d < div` and `d <= div` are interchangeable here (proven by mutation): the
  // extra point `d = div` lands exactly on `b`, which the NEXT gap emits as its
  // own `d = 0` and the ascending de-duplication then drops. The half-open form
  // is kept because it says what it means — each gap owns its own points and
  // the closing beat is emitted once, below.
  const out: number[] = [];
  for (let i = 0; i < n - 1; i++) {
    const a = beatSamples[i];
    const b = beatSamples[i + 1];
    for (let d = 0; d < div; d++) {
      const pos = Math.round(a + ((b - a) * d) / div);
      if (out.length === 0 || pos > out[out.length - 1]) out.push(pos);
    }
  }
  const last = beatSamples[n - 1];
  if (out.length === 0 || last > out[out.length - 1]) out.push(last);
  return Int32Array.from(out);
}

// ---------------------------------------------------------------------------
// The warp map
// ---------------------------------------------------------------------------

export interface TimingAnchor {
  /** Where the syllable IS, in input samples. */
  source: number;
  /** Where it SHOULD be, in output samples of the same region. */
  target: number;
}

export interface WarpMapOptions {
  /** Fraction of each anchor's requested move to actually apply, `0..1`.
   * 0 is an exact identity map. See {@link DEFAULT_STRENGTH}. */
  strength: number;
  /** Local ratio floor. Defaults to {@link MIN_LOCAL_RATIO}. */
  minRatio?: number;
  /** Local ratio ceiling. Defaults to {@link MAX_LOCAL_RATIO}. */
  maxRatio?: number;
}

/**
 * The geometry every knot-based time map in this repo shares: two parallel,
 * strictly ascending knot arrays and the two lengths they span.
 * {@link analysisPosAt} and {@link synthesisPosAt} need nothing else, so they
 * are typed against THIS rather than against {@link WarpMap} — which is what
 * lets `tempoMap.ts`'s variable-rate Match Tempo map (R7) reuse the same
 * piecewise-linear inverse instead of carrying a second copy of the binary
 * search. The two maps differ only in how their knots are CHOSEN; reading them
 * is identical, and a second implementation would be a second thing to keep
 * correct.
 */
export interface PiecewiseTimeMap {
  /** Input length, in samples. */
  inLen: number;
  /** Output length, in samples. */
  outLen: number;
  /** Knot input positions, ascending, starting at 0 and ending at `inLen`. */
  knotsIn: Float64Array;
  /** Knot output positions, ascending, starting at 0 and ending at `outLen`.
   * Parallel to {@link knotsIn}. */
  knotsOut: Float64Array;
}

export interface WarpMap extends PiecewiseTimeMap {
  /** Output length. ALWAYS equal to {@link inLen} — see {@link buildWarpMap}. */
  outLen: number;
  /** Where each accepted anchor actually landed, parallel to the accepted
   * anchors (i.e. to {@link acceptedIndices}). */
  placed: Float64Array;
  /** Indices into the CALLER's anchor array for the anchors that became knots.
   * An anchor can be dropped for being out of range or out of order. */
  acceptedIndices: number[];
  /** Indices into the caller's anchor array whose requested position could not
   * be reached because the ratio bound held it back. It was moved as far as the
   * bound allows, and this is how the caller says so. */
  clampedIndices: number[];
  /** True when nothing moves — no accepted anchor, or strength 0. The caller
   * should skip the stretch entirely: see {@link applyTimingWarp}. */
  identity: boolean;
}

/** Whether every knot pair's ratio is inside `[minRatio, maxRatio]` — the
 * invariant `buildWarpMap` establishes, exported so tests assert the property
 * rather than a sample of it. */
export function warpRatios(map: PiecewiseTimeMap): Float64Array {
  const n = map.knotsIn.length;
  const out = new Float64Array(Math.max(0, n - 1));
  for (let i = 0; i < n - 1; i++) {
    const din = map.knotsIn[i + 1] - map.knotsIn[i];
    out[i] = din > 0 ? (map.knotsOut[i + 1] - map.knotsOut[i]) / din : 1;
  }
  return out;
}

/**
 * The input position whose content belongs at output position `v` — the
 * `analysisPosAt` that `timeStretchVariableLinked` consumes.
 *
 * Piecewise-linear inverse of the knot map, monotone non-decreasing by
 * construction (every knot interval has a strictly positive width in both
 * domains), with range clamped into `[0, inLen]`.
 */
export function analysisPosAt(map: PiecewiseTimeMap, v: number): number {
  const { knotsIn, knotsOut, inLen } = map;
  const last = knotsOut.length - 1;

  // No early-outs for `v <= 0` or `v >= outLen`. They existed, and a mutation
  // sweep proved both were EQUIVALENT: out of range the search saturates on the
  // first or last segment, extrapolates linearly past its knot, and the final
  // clamp below returns exactly what the early-out would have. A branch no
  // mutation can kill is a branch that is not carrying anything.
  //
  // The `<=` in the search below is likewise interchangeable with `<` (also
  // proven by mutation): on an exact knot hit `<=` brackets [j, j+1] with
  // frac 0 and `<` brackets [j-1, j] with frac 1, and both evaluate to
  // `knotsIn[j]`.
  let lo = 0;
  let hi = last;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (knotsOut[mid] <= v) lo = mid;
    else hi = mid;
  }
  const dOut = knotsOut[hi] - knotsOut[lo];
  if (dOut <= 0) return knotsIn[lo];
  const frac = (v - knotsOut[lo]) / dOut;
  const pos = knotsIn[lo] + frac * (knotsIn[hi] - knotsIn[lo]);
  return pos < 0 ? 0 : pos > inLen ? inLen : pos;
}

/**
 * The FORWARD map: where the content currently at input position `u` ends up in
 * the output. The exact inverse of {@link analysisPosAt}, and the same
 * piecewise-linear geometry read the other way round.
 *
 * This exists so anything ANNOTATING the audio — markers, above all — can be
 * moved by the same function the samples were moved by. `effectRunner`'s
 * marker remap has two rules, `'stretch'` (proportional across the region) and
 * `'cuts'`, and **both are wrong for a variable-rate warp**: proportional is
 * correct only where the local ratio equals the region's average ratio, which
 * here is exactly 1 everywhere and therefore leaves every marker where it was
 * while the syllable it marks moves out from under it. F2 hit the same class of
 * bug from the other side — a proportional remap scattered every marker after a
 * removed gap — and the fix was the same: map each annotation through the
 * transform the audio actually underwent.
 */
export function synthesisPosAt(map: PiecewiseTimeMap, u: number): number {
  const { knotsIn, knotsOut, outLen } = map;
  const last = knotsIn.length - 1;

  let lo = 0;
  let hi = last;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (knotsIn[mid] <= u) lo = mid;
    else hi = mid;
  }
  const dIn = knotsIn[hi] - knotsIn[lo];
  if (dIn <= 0) return knotsOut[lo];
  const frac = (u - knotsIn[lo]) / dIn;
  const pos = knotsOut[lo] + frac * (knotsOut[hi] - knotsOut[lo]);
  return pos < 0 ? 0 : pos > outLen ? outLen : pos;
}

/**
 * Builds the monotonic, ratio-bounded time map that moves each anchor's source
 * toward its target.
 *
 * **The output length always equals the input length.** Timing alignment moves
 * syllables *within* a region; it does not change the region's duration. If it
 * did, every clip, marker and track after the region would slide, which is not
 * what "the singing is offbeat" asks for. Both ends are therefore pinned knots
 * — `(0,0)` and `(inLen, inLen)`.
 *
 * ### Anchors that are refused rather than repaired
 * An anchor is dropped (and its index left out of `acceptedIndices`) when its
 * source is not strictly inside `(0, inLen)`, when it is not strictly after the
 * previous accepted source, or when either coordinate is not finite. Dropping
 * is right rather than sorting or merging: a caller that hands over unordered
 * or duplicate anchors has a bug upstream, and silently repairing it would move
 * audio according to a guess about what it meant.
 *
 * ### The bound, and what happens at it
 * Each segment's ratio is held inside `[minRatio, maxRatio]` by a two-phase
 * pass. First a BACKWARD pass computes, for every knot, the interval of output
 * positions from which the pinned right end is still reachable within the
 * bound. Then a FORWARD pass places each knot at its requested position clamped
 * into the intersection of (a) what the bound allows given where the previous
 * knot actually landed and (b) that backward-reachable interval. The
 * intersection is never empty: the identity placement `t = s` satisfies every
 * constraint (ratio 1), so a feasible completion always exists, and by
 * induction the forward pass can always take one more step. An anchor whose
 * request lay outside its interval is placed at the nearest end of it — moved
 * as far as the bound allows — and its index is reported in `clampedIndices`
 * so the caller can say so instead of silently under-delivering.
 */
export function buildWarpMap(
  anchors: readonly TimingAnchor[],
  inputLength: number,
  opts: WarpMapOptions
): WarpMap {
  const inLen = Math.max(0, Math.floor(inputLength));
  // The band is held inside the engine's own limits AND forced to contain 1.
  // Containing 1 is what makes the identity placement feasible, which is the
  // induction step the forward pass below relies on — a caller-supplied band
  // like [1.2, 1.5] would otherwise make the pinned end unreachable.
  const minRatio = Math.min(1, Math.max(MIN_RATIO, opts.minRatio ?? MIN_LOCAL_RATIO));
  const maxRatio = Math.max(1, Math.min(MAX_RATIO, opts.maxRatio ?? MAX_LOCAL_RATIO));
  const strength = Number.isFinite(opts.strength) ? Math.min(1, Math.max(0, opts.strength)) : 0;

  const identityMap = (): WarpMap => ({
    inLen,
    outLen: inLen,
    knotsIn: Float64Array.from([0, inLen]),
    knotsOut: Float64Array.from([0, inLen]),
    placed: new Float64Array(0),
    acceptedIndices: [],
    clampedIndices: [],
    identity: true,
  });

  if (inLen <= 0 || strength === 0 || anchors.length === 0) return identityMap();

  // --- accept anchors ------------------------------------------------------
  const acceptedIndices: number[] = [];
  const sources: number[] = [];
  const wanted: number[] = [];
  let prevSource = 0;
  for (let i = 0; i < anchors.length; i++) {
    const { source, target } = anchors[i];
    if (!Number.isFinite(source) || !Number.isFinite(target)) continue;
    if (source <= prevSource || source >= inLen) continue;
    acceptedIndices.push(i);
    sources.push(source);
    wanted.push(source + strength * (target - source));
    prevSource = source;
  }
  if (acceptedIndices.length === 0) return identityMap();

  // Knots: pinned start, the accepted anchors, pinned end.
  const k = acceptedIndices.length + 2;
  const knotsIn = new Float64Array(k);
  const desired = new Float64Array(k);
  knotsIn[0] = 0;
  desired[0] = 0;
  for (let j = 0; j < acceptedIndices.length; j++) {
    knotsIn[j + 1] = sources[j];
    desired[j + 1] = wanted[j];
  }
  knotsIn[k - 1] = inLen;
  desired[k - 1] = inLen;

  // --- backward reachability from the pinned end ---------------------------
  // backLo[j]/backHi[j]: the output positions for knot j from which knot k-1
  // can still be reached at inLen without leaving the ratio band.
  const backLo = new Float64Array(k);
  const backHi = new Float64Array(k);
  backLo[k - 1] = inLen;
  backHi[k - 1] = inLen;
  for (let j = k - 2; j >= 0; j--) {
    const d = knotsIn[j + 1] - knotsIn[j];
    backLo[j] = backLo[j + 1] - d * maxRatio;
    backHi[j] = backHi[j + 1] - d * minRatio;
  }

  // --- forward placement ---------------------------------------------------
  // Only the INTERIOR knots are placed here. The pinned end is not a decision:
  // knot `k-2` was placed inside `[backLo, backHi]`, which is exactly the set
  // of positions from which `inLen` is one in-band step away, so the last
  // segment's ratio is already guaranteed and the pin is assigned directly.
  // Running it through the loop would add a branch (`j < k-1`) that no test
  // could kill, because the pin can never be the thing that clamps.
  const knotsOut = new Float64Array(k);
  const clampedIndices: number[] = [];
  knotsOut[0] = 0;
  for (let j = 1; j < k - 1; j++) {
    const d = knotsIn[j] - knotsIn[j - 1];
    let lo = knotsOut[j - 1] + d * minRatio;
    let hi = knotsOut[j - 1] + d * maxRatio;
    if (backLo[j] > lo) lo = backLo[j];
    if (backHi[j] < hi) hi = backHi[j];
    // Non-empty by induction (the identity placement is feasible because the
    // band contains 1); the guard only absorbs floating-point ulps.
    if (hi < lo) hi = lo;

    const want = desired[j];
    let placedJ = want;
    if (want < lo) placedJ = lo;
    else if (want > hi) placedJ = hi;
    knotsOut[j] = placedJ;

    if (Math.abs(placedJ - want) > 1e-9) clampedIndices.push(acceptedIndices[j - 1]);
  }
  knotsOut[k - 1] = inLen;

  const placed = new Float64Array(acceptedIndices.length);
  for (let j = 0; j < acceptedIndices.length; j++) placed[j] = knotsOut[j + 1];

  let identity = true;
  for (let j = 1; j < k - 1; j++) {
    if (Math.abs(knotsOut[j] - knotsIn[j]) > 1e-9) {
      identity = false;
      break;
    }
  }

  return { inLen, outLen: inLen, knotsIn, knotsOut, placed, acceptedIndices, clampedIndices, identity };
}

// ---------------------------------------------------------------------------
// Applying it
// ---------------------------------------------------------------------------

/**
 * Warps `channels` so each anchor's source lands at (or as near as the bound
 * allows to) its target, preserving pitch and the stereo image.
 *
 * An identity map — no accepted anchor, or strength 0 — returns **copies of the
 * input samples, byte for byte**. It does NOT run WSOLA at ratio 1: the
 * similarity search is a near-passthrough, not a passthrough, so "strength 0
 * changes nothing" has to be a short circuit to be true. It is pinned by test.
 *
 * Otherwise the map goes straight to `timeStretchVariableLinked`, which runs
 * ONE similarity search over the channel mean and applies the same offsets to
 * every channel — so the inter-channel phase relationship survives, exactly as
 * it does for Pitch Correct.
 */
export function applyTimingWarp(
  channels: Float32Array[],
  sampleRate: number,
  anchors: readonly TimingAnchor[],
  opts: WarpMapOptions,
  onProgress?: (fraction: number) => void
): { channels: Float32Array[]; map: WarpMap } {
  const inLen = channels[0]?.length ?? 0;
  const map = buildWarpMap(anchors, inLen, opts);

  if (map.identity) {
    onProgress?.(1);
    return { channels: channels.map((c) => Float32Array.from(c)), map };
  }

  const out = timeStretchVariableLinked(
    channels,
    sampleRate,
    map.outLen,
    (v) => analysisPosAt(map, v),
    onProgress
  );
  return { channels: out, map };
}
