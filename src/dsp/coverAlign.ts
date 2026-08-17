/**
 * Task CP1 — global alignment of a cover take to the original vocal.
 *
 * ── What this is, said plainly ──────────────────────────────────────────────
 * ONE number: where the take's first sample belongs on the original's timeline.
 * It is a PLACEMENT, not a warp — nothing here stretches, nudges a syllable or
 * touches a sample. The app's warp tools (Align Vocal Timing, Align Lyrics) are
 * deliberately manual because they need a confirmed grid and a chosen word, and
 * this stage does not pretend to replace them.
 *
 * A take that drifts against the original therefore stays drifting — and CC2
 * MEASURES how much rather than asserting it does not matter. The header used to
 * say a drifting take "stays drifting", i.e. still gets placed, which was false:
 * measured, a take running 0.5 % slow over 20 s scored 0.34–0.41 and was refused
 * outright, its best lag wrong by up to 17 s. What is true now is stated in the
 * outcomes: below {@link ALIGN_MAX_DRIFT_SPAN_SECONDS} a drifting take is
 * still placed and the drift is reported alongside; above it the placement
 * becomes a `'weak'` guess with the drift named, because one rigid lag has
 * stopped being an answer to the question.
 *
 * ── It composes; it does not re-implement ───────────────────────────────────
 * The feature this correlates is the app's OWN onset-strength envelope:
 * `tempoCore.onsetEnvelope`, the log-band spectral flux the tempo tracker and
 * the beat grid already run on. The signal reaching it is reduced to mono by
 * `chainAnalysis.monoMix` and — for the coarse pass — brought to
 * {@link ALIGN_ANALYSIS_RATE_HZ} by `resample.resampleChannel`. The correlation
 * itself is `fft`/`ifft`. Nothing about attack detection is invented here.
 *
 * (`tempoCore.decimateMono` is NOT used. It appears below only as one of the two
 * REJECTED designs, and it is named there as rejected.)
 *
 * Correlating the ONSET envelope rather than a level envelope is the decision
 * that makes the refusal arm work at all. Two unrelated recordings of singing
 * have similar amounts of silence and similar loud sections, so their LEVEL
 * envelopes correlate on the shape of "someone is singing"; their attacks do
 * not line up, and a flux envelope is zero everywhere except at an attack.
 *
 * ── Two passes, because one cannot do both jobs ─────────────────────────────
 * This was built as a single full-rate pass first, and MEASURED. Framing the
 * audio at 44.1 kHz gives 5.8 ms frames — lovely time resolution — but
 * `onsetEnvelope`'s FFT size and band table are fixed, so at 44.1 kHz its 24
 * log bands from 80 Hz to 3.5 kHz fall on 43 Hz-wide bins and the narrow low
 * ones collapse into each other. The flux gets noisy, and the populations the
 * confidence has to separate OVERLAPPED: across 24 constructed pairs the worst
 * cover scored 0.152 prominence and the best unrelated pair scored 0.155. There
 * is no threshold in a negative gap.
 *
 * The second attempt ran the coarse pass over `tempoCore.decimateMono`, whose
 * ~11 kHz target gives the sharpest bands of all — and it was measured too, and
 * it was WORSE (worst cover 0.2035 against best unrelated 0.2045). Sharper bands
 * on their own are not the answer either.
 *
 * What ships is the rate the sweep actually separated on,
 * {@link ALIGN_ANALYSIS_RATE_HZ}: bins 21.5 Hz wide, and 23 of
 * `onsetEnvelope`'s 24 bands surviving its own same-bin dedup against 21 at
 * 44.1 kHz (measured — see "the analysis rate's band table"). All 24 survive at
 * 11 kHz, which is precisely why band count alone was not the answer, and
 * still enough bandwidth that a vocal's 80 Hz–3.5 kHz is entirely inside it. The
 * two questions are then asked separately, of the pass that can answer each:
 *
 *   - WHERE, ROUGHLY, and CAN IT BE BELIEVED — on the ODF of both signals
 *     brought to that ONE fixed analysis rate, so the flux each carries is
 *     computed over identical bands whatever the files' own rates were. This is
 *     the pass the confidence comes from, and it searches every lag.
 *   - EXACTLY WHERE — on the ODF of each signal at its OWN rate (5.8 ms frames
 *     at 44.1 kHz against the coarse pass's 11.6 ms), correlated ONLY inside
 *     ±{@link ALIGN_REFINE_SECONDS} of the coarse answer, where the band noise
 *     no longer has a wrong lag to prefer, and interpolated parabolically on
 *     top of that.
 *
 * Both passes put their envelopes on the SAME frame grid,
 * {@link ALIGN_FRAME_RATE_HZ}, so a lag means the same thing whatever the two
 * files' rates are — and so the coarse answer can be handed to the fine pass as
 * a window without a units conversion in between.
 *
 * ── REJECTED: a third pass against the ORIGINAL SONG ────────────────────────
 * Both passes above correlate the take against the SEPARATED VOCAL, which is the
 * one signal in the journey that has been through a model. A user whose
 * placement was audibly off asked the obvious question — why not compare against
 * the original song, which has been through nothing? — and V3 shipped exactly
 * that: a third pass refining the stem passes' answer against the mix.
 *
 * It was WRONG, it reached a release, and the packaged smoke caught it. The
 * measurement is kept in `coverAlign.test.ts` → "the original song is a worse
 * ruler than the stem that came out of it" so that the idea, which is a good one
 * until it is measured, is not had twice.
 *
 * The premise was that the mix and the stem share one timeline — true, they sum
 * bit for bit — and therefore share one set of ONSETS. That second part is false.
 * An onset envelope is spectral flux, and accompaniment sitting under a vocal
 * DILUTES the flux at the vocal's attacks, so the mix's onsets land late of the
 * same vocal's. Measured, on a reconstruction of the packaged smoke's own
 * fixture, as the bed is swept from 52 dB under the vocal up to 8 dB under it
 * (the figures are the kept test's own, printed by it):
 *
 *     bed under vocal   stem-path error   mix-refined error   stem-on-mix lag
 *          −52 dB           −0.08 ms            3.34 ms            3.13 ms
 *          −42 dB           −0.08 ms            4.97 ms            4.98 ms
 *          −32 dB           −0.08 ms            7.13 ms            7.22 ms
 *          −22 dB           −0.08 ms           10.15 ms           10.23 ms
 *          −18 dB           −0.08 ms           11.39 ms           11.20 ms
 *          −14 dB           −0.08 ms           12.72 ms           12.13 ms
 *           −8 dB           −0.08 ms           12.94 ms           12.35 ms
 *
 * −14 dB is the shipped fixture's own balance, and 12.72 ms is the number the
 * packaged smoke reported as 13.03 ms against the same pair's 16-bit stereo
 * files. Run on those files directly, the two passes that ship now recover
 * −0.7500725793196249 against a built-in −0.75 — an error of 0.07 ms.
 *
 * Past the bottom of that sweep the accompaniment stops biasing the answer and
 * starts winning it outright: at 2 dB under the vocal the mix-refined error is
 * −49.11 ms. That is a different failure and the sweep stops short of it
 * deliberately, because the one being derived here is the bias.
 *
 * Two things to read there. The stem path is EXACT at every bed level, because
 * its reference is the vocal and the bed is not in it. And the mix-refined error
 * equals the stem-on-mix lag at every level — the pass's whole effect was to
 * transfer the placement onto a ruler whose zero had moved, by exactly the amount
 * the zero had moved. It never recovered anything about the take.
 *
 * There is no correction for it either, and the same table is the proof: the
 * only way to measure the bias is the stem-on-mix lag, and subtracting that from
 * the mix's answer returns the stem's answer, which is where we started. The mix
 * carries no information about where the take belongs that the stem does not,
 * and it carries a bias the stem does not. So the reference stays the stem.
 *
 * (The bias does not conveniently vanish for quiet accompaniment: 3.3 ms at
 * 52 dB down, and 12 ms — larger than the ±10 ms this module publishes — at the
 * 14 dB of an ordinary pop balance.)
 *
 * `onsetEnvelope`'s frame-attribution bias (module note in `tempoCore`: an
 * attack lands up to one hop LATE) applies identically to both signals and so
 * cancels in a cross-correlation. It would matter to an absolute beat position;
 * it does not matter to a difference of two.
 *
 * ── Confidence: three measurements, and four honest answers ────────────────
 * `peakCorrelation` is the Pearson correlation of the two coarse envelopes —
 * LOW-PASSED first, see {@link ALIGN_SMOOTHING_MS} — at the winning lag.
 * `prominence` is that peak minus the best rival lag at least
 * {@link ALIGN_GUARD_SECONDS} away: "is there ONE lag that stands out".
 * `windowLagSpreadSeconds` is what independently-aligned windows of the take say
 * about each other: "does that one lag hold across the whole take".
 *
 * CC2 rebuilt this arm because it refused a real user's real cover. The floors
 * were calibrated on constructed takes that shared the reference's onsets TO THE
 * SAMPLE, and a human being does not: at ±40 ms of per-syllable variance the
 * peak fell to 0.43–0.57 while the recovered offset stayed correct to 29 ms.
 * That was not a threshold in the wrong place — the user's 0.423 sat INSIDE the
 * unrelated population's own range, so no floor could have separated them. The
 * evidence had to change: the envelopes are smoothed so onset lobes span human
 * timing, and the piecewise windows add a second, independent opinion.
 *
 * The answer is then one of four (see {@link AlignmentOutcome}) rather than a
 * boolean, because "not believable" was being said to a take that matches
 * several places, to a take that drifts, and to a take with no relation at all —
 * three different sentences, only one of them true.
 *
 * Every threshold comes from the sweep in `coverAlign.test.ts` and the test
 * asserts the shipped constants still sit inside the measured gap by a stated
 * margin. See the constants for the figures.
 */

import { monoMix } from './chainAnalysis';
import { fft, ifft, nextPow2 } from './fft';
import { resampleChannel } from './resample';
import { onsetEnvelope } from './tempoCore';

/**
 * The common frame grid the FINE envelopes are resampled onto, in frames per
 * second. 200 Hz is 5 ms per lag, comfortably inside the ±10 ms the alignment
 * is required to hit before the parabolic interpolation is counted at all —
 * chosen so the requirement does not RELY on the interpolation.
 */
export const ALIGN_FRAME_RATE_HZ = 200;

/**
 * The one rate BOTH signals are brought to before the coarse pass frames them.
 * See the module header for the two rates this was measured against and why
 * each lost. A file already at this rate is copied rather than resampled; a file
 * BELOW it is resampled up, which invents no detail but does keep the two ODFs
 * on one grid, and a pair of files at very different rates simply has less
 * shared spectrum to correlate — that shows up as a lower peak, which is
 * exactly what the confidence floor is for.
 */
export const ALIGN_ANALYSIS_RATE_HZ = 22050;

/**
 * The coarse pass's grid — the SAME grid, deliberately. Leaving the coarse ODF
 * on its own 86.1 frames/s was measured as well and lost (worst cover 0.1476
 * against best unrelated 0.1829): a rival search that samples the correlation
 * surface coarsely finds a lower runner-up than the surface really has, which
 * inflates the prominence of coincidences more than it inflates the prominence
 * of alignments. One grid for both passes is also what lets the coarse offset be
 * handed to the fine pass as a window with no conversion.
 */
export const ALIGN_COARSE_FRAME_RATE_HZ = ALIGN_FRAME_RATE_HZ;

/**
 * How far the fine pass is allowed to move the coarse answer. One coarse frame
 * is 11.6 ms and the coarse peak is interpolated, so the residual is a small
 * multiple of that; 0.2 s is an order of magnitude of headroom and still narrow
 * enough that the fine pass cannot wander to a different verse.
 */
export const ALIGN_REFINE_SECONDS = 0.2;

/**
 * How far from the winning lag a rival has to be before it counts as a rival.
 * A correlation peak has shoulders — the frames either side of the true lag are
 * high because a syllable is not an impulse — and counting one of those as the
 * runner-up would report prominence ~0 for a perfect alignment. 0.35 s is just
 * over the longest syllable the ground-truth schedule draws (0.37 s of attack
 * plus decay, whose correlation shoulder is roughly half that).
 */
export const ALIGN_GUARD_SECONDS = 0.35;

/**
 * The shortest overlap a lag may be evaluated at. Below this the Pearson
 * denominator is computed over a handful of frames and returns ±1 for any two
 * signals at all — the classic normalised-cross-correlation edge artefact. Two
 * seconds, or 20 % of the shorter recording when that is more, so a short take
 * against a long song is still allowed most of its lag range.
 */
export const ALIGN_MIN_OVERLAP_SECONDS = 2;

/** …and the fraction of the shorter signal that overrides it when larger. */
export const ALIGN_MIN_OVERLAP_FRACTION = 0.2;

/**
 * CC2. How much the two COARSE onset envelopes are low-passed before the
 * Pearson pass, in milliseconds of Hann kernel.
 *
 * MEASURED, in `coverAlign.test.ts` → "derives the smoothing width from the
 * populations it has to separate", which sweeps candidate widths over the same
 * populations the floors come from and asserts this constant is the argmax.
 *
 * WHY there is a kernel at all. An onset envelope is near-zero everywhere
 * except at an attack, and the shipped floors were calibrated on takes that
 * shared the reference's attacks TO THE SAMPLE — same seed, same schedule. A
 * human being is early on one word and late on the next; at ±40 ms the two sets
 * of lobes barely touch at ANY lag, peak correlation falls to 0.43–0.57, and
 * the run is refused WHILE THE RECOVERED OFFSET IS STILL CORRECT to 29 ms.
 * That is not a threshold that needs moving — the user's 0.423 sat inside the
 * unrelated population's own range, so no floor could have separated them. The
 * EVIDENCE had to change. Widening each lobe so it spans the variance is the
 * change; the width is swept rather than chosen because too wide turns both
 * envelopes into slow curves that correlate whatever they are.
 *
 * The FINE envelopes are deliberately left alone: the coarse pass answers "can
 * this be believed", the fine pass answers "exactly where", and blurring the
 * one that has to be exact would trade the ±10 ms for nothing.
 */
export const ALIGN_SMOOTHING_MS = 240;

/**
 * The prominence a result must reach for the answer to be ONE PLACE.
 *
 * CC2 changed what this floor is FOR. It used to be half of the "is this even
 * the same song" test, derived against unrelated audio — and at the smoothing
 * width the correlation arm now needs, that gap has not merely closed but
 * INVERTED: unrelated audio reaches 0.2491 prominence while the worst cover
 * reaches 0.217. The populations overlap by 0.032 in the wrong direction.
 * Prominence cannot carry relatedness any more, and pretending otherwise would
 * be a floor with no margin — or a floor with a negative one.
 *
 * What prominence separates CLEANLY is a different question, and the one it was
 * always really asking: does ONE lag stand out, or do several? MEASURED, in
 * `coverAlign.test.ts` → "the measured separation", against a population the
 * calibration never had — a song whose section repeats three times, where the
 * rival lag one section away is a GENUINE partial match:
 *
 *     aperiodic cover prominence     0.217 … 0.537
 *     repeated-section prominence    0.0011 … 0.0139, peak still 0.876 … 0.899
 *     two metronomes at one tempo    0.0132 … 0.0241, peak 0.9539 … 0.9577
 *
 * A run below this floor is not refused as unbelievable — it is reported as
 * {@link AlignmentMeasurement.outcome} `'ambiguous'`, with the guard-separated
 * rivals on `candidates`, because "this take matches several places" is a
 * different sentence from "this take matches nothing" and the user can answer
 * only the first one.
 */
export const ALIGN_MIN_PROMINENCE = 0.12;

/**
 * …and the floor on the peak correlation itself, which is what now carries
 * relatedness. Same sweep, same test, over a cover population that includes the
 * ±40 ms human timing variance the shipped 0.607 was never calibrated against.
 * See the printed populations; the constant is the middle of the measured gap.
 *
 * CC2 fix-round (IMP-1): the population it sits above is no longer only
 * different-seed syllable schedules. Smoothing lifted unrelated audio by 0.21
 * and prominence retired as a second barrier, so the safety side had to grow to
 * match — it now also contains a LEAKAGE stem (the song's accompaniment 40 dB
 * down under a noise floor, which is what this repo measured the real separator
 * leaving behind), and ROOM TONE on each side in turn. Measured ceilings:
 * leakage 0.6454, room-tone reference 0.6345, room-tone take 0.6538 — the last
 * of which is what this floor's lower margin is actually measured against.
 *
 * One unrelated shape is deliberately NOT under this floor and cannot be: two
 * recordings sharing only a TEMPO peak at 0.9539–0.9577, because two metronomes
 * genuinely do match at many lags. Their prominence collapses to ≤0.0241 and
 * they are answered by {@link ALIGN_MIN_PROMINENCE} as `'ambiguous'` — never
 * `'confident'`, which is the property that matters and which the sweep asserts.
 */
export const ALIGN_MIN_CORRELATION = 0.731;

/**
 * CC2 fix-round (IMP-3). The correlation above which a take is DISTINGUISHABLE
 * from unrelated audio, even when nothing else can be measured about it.
 *
 * Between this and {@link ALIGN_MIN_CORRELATION} lies a gap zone: a peak too low
 * to be believed, yet above every unrelated pair the sweep can produce —
 * including the leakage and room-tone members. Before this constant existed such
 * a take was called `'unrelated'` ("no usable guess") whenever the overlap was
 * too short for the piecewise arm to speak, which is exactly the length of take
 * users record. Correlation above the unrelated ceiling IS evidence, and the
 * honest answer is `'weak'`: a guess to OFFER. The harm is bounded because
 * `'weak'` is never applied automatically.
 *
 * The rule the gap zone follows, in full:
 *   - piecewise evidence UNAVAILABLE → `'weak'`. Nothing contradicts the peak.
 *   - piecewise windows AVAILABLE AND DISAGREEING → `'unrelated'`. The second
 *     arm is actively against it, and two arms disagreeing is not a guess worth
 *     showing.
 *
 * MEASURED like every other threshold: the middle of the gap between the
 * unrelated ceiling (0.6538) and the acceptance floor, asserted from both edges.
 */
export const ALIGN_WEAK_CORRELATION = 0.692;

/** …and its margin from the unrelated ceiling below and the acceptance floor
 * above. Narrower than the acceptance margins because it splits what is left of
 * one gap rather than spanning a gap of its own — stated rather than hidden. */
export const ALIGN_WEAK_CORRELATION_MARGIN = 0.03;

/**
 * CP1 fix-round. How far each floor must sit from BOTH population edges.
 *
 * The gap being non-empty is not enough, and asserting membership with bare
 * `<`/`>` said only that: a floor could drift to within 0.0001 of the population
 * it exists to exclude and every test would still pass. These are the margins
 * the shipped floors ACTUALLY clear, each rounded DOWN to a blunt figure, so the
 * assertion has real teeth and any erosion of a gap trips it rather than
 * silently eating the slack.
 *
 * CC2 re-derived both against the new populations. The correlation margin fell
 * from 0.15 to 0.07 and that is the honest cost of the change: a cover sung with
 * human timing scores lower than a sample-identical one, so the gap it has to
 * sit in is narrower. It is a real 0.07 on both sides of a measured gap rather
 * than a comfortable number over a population no user will ever produce.
 */
export const ALIGN_PROMINENCE_MARGIN = 0.09;
/** …and the same for the correlation gap. */
export const ALIGN_CORRELATION_MARGIN = 0.07;

/**
 * CC2. How long each piecewise window is, in seconds of overlap.
 *
 * The global answer is ONE rigid lag over the whole take, which cannot tell "the
 * whole take sits 8 s late" from "the take starts right and slides". So the
 * overlap is cut into windows and each is aligned INDEPENDENTLY, full lag range,
 * against the whole reference. Three seconds is the shortest window the sweep
 * still recovers a lag from reliably; below it the Pearson denominator is
 * computed over a few hundred frames and starts preferring coincidences (the
 * same edge the min-overlap gate exists for).
 */
export const ALIGN_PIECEWISE_WINDOW_SECONDS = 3;
/** Fewer than three windows cannot show a trend at all — two points are a line
 * whatever they are. */
export const ALIGN_PIECEWISE_MIN_WINDOWS = 3;
/** …and past a dozen the windows get shorter than the material needs without
 * telling anyone anything new about a straight line. */
export const ALIGN_PIECEWISE_MAX_WINDOWS = 12;

/**
 * CC2. How far the independently-aligned windows may disagree, in seconds,
 * before the take is not one placement at all.
 *
 * MEASURED, in `coverAlign.test.ts` → "the measured separation". This is the
 * evidence that survives when the correlation arm is marginal, and it is a far
 * wider gap than either floor above: every cover population — sample-identical,
 * ±40 ms human, and drifting — keeps its windows within a few tens of
 * milliseconds of one another, while unrelated audio's windows land half a
 * second to four seconds apart, because there is no lag for them to agree ON.
 */
export const ALIGN_MAX_LAG_SPREAD_SECONDS = 0.34;

/** …and how far that ceiling must sit from BOTH population edges, on the same
 * principle as the two floor margins above. */
export const ALIGN_LAG_SPREAD_MARGIN = 0.3;

/**
 * CC2. How far the take may SLIDE across the overlap, in seconds, before one
 * rigid lag stops being an answer.
 *
 * The piecewise window lags are fitted with a straight line; its slope is the
 * drift. The gate is not on the slope itself but on `|slope| × overlap` — how
 * far the take has moved from one end of the shared audio to the other —
 * because a slope estimated over three windows of a ten-second take is far
 * noisier than the same slope over a four-minute song, and a rate threshold
 * would refuse short takes for measurement noise while letting long ones drift.
 * The SPAN is the quantity that actually costs the user a placement, and it is
 * the one that is scale-correct.
 *
 * MEASURED, in `coverAlign.test.ts` → "derives the drift ceiling against a
 * no-drift control", against controls of the same lengths and constructions with
 * `tempoScale` 1, so the figure separates real drift from the slope a straight
 * line finds in a few noisy points rather than from zero.
 *
 * Above it the outcome is `'weak'` — a usable guess with a stated drift, not a
 * refusal. Below it the drift is still REPORTED
 * ({@link AlignmentMeasurement.driftSecondsPerMinute}), because the sweep
 * measured 15–30 ms of placement error at a drift this gate deliberately lets
 * through, and a caller quoting the module's ±10 ms deserves to know.
 */
export const ALIGN_MAX_DRIFT_SPAN_SECONDS = 0.057;

/** …and its margin from both edges of the measured populations. */
export const ALIGN_DRIFT_MARGIN = 0.02;

/** CC2. How many guard-separated lags are carried on `candidates`. Three: the
 * chosen one and the two rivals a repeated section produces. */
export const ALIGN_CANDIDATE_COUNT = 3;

/**
 * CC2. What the evidence adds up to. Four outcomes rather than one boolean,
 * because "not believable" was being said to four different situations and only
 * one of them was true.
 *
 * - `confident` — one lag, agreed on by independently-aligned windows, standing
 *   out from the field. Applied automatically; the pre-CC2 `confident: true`.
 * - `ambiguous` — a strong peak that several lags share, which is what a song
 *   with a repeated chorus looks like. `candidates` carries the guard-separated
 *   rivals. NEVER auto-accepted: the peak lands on the wrong repeat about half
 *   the time, so this is a question for the user, not an answer.
 * - `weak` — below acceptance, but distinguishable from unrelated audio. Three
 *   ways in: the peak clears its floor without the windows agreeing; the windows
 *   agree without the peak clearing; or the peak sits in the GAP ZONE between
 *   {@link ALIGN_WEAK_CORRELATION} and {@link ALIGN_MIN_CORRELATION} — above
 *   every unrelated pair the sweep can build — with no piecewise evidence to
 *   contradict it. A usable guess to OFFER, not to apply. `candidates` is
 *   carried here too, so a caller can show the alternatives rather than one
 *   number the user has to trust.
 * - `unrelated` — no arm distinguishes it from the measured unrelated band. A
 *   gap-zone peak lands here ONLY when the piecewise windows are available AND
 *   disagree: evidence actively against, rather than evidence merely absent.
 *   No guess worth showing.
 */
export type AlignmentOutcome = 'confident' | 'ambiguous' | 'weak' | 'unrelated';

/** CC2. One lag the correlation surface likes, guard-separated from the others.
 * `candidates[0]` is always the lag `offsetSeconds` reports. */
export interface AlignmentCandidate {
  /** Same meaning as {@link AlignmentMeasurement.offsetSeconds}, refined by the
   * fine pass in the same way. */
  offsetSeconds: number;
  /** Its peak on the coarse surface. */
  correlation: number;
  /** …minus the best rival at least {@link ALIGN_GUARD_SECONDS} from IT. */
  prominence: number;
}

export interface AlignmentMeasurement {
  /**
   * Where the take's sample 0 belongs on the reference's timeline, in seconds.
   * POSITIVE means the take starts later than the reference does; negative
   * means it starts before the reference's own zero.
   */
  offsetSeconds: number;
  /** Pearson correlation of the two coarse onset envelopes at the winning lag,
   * in [−1, 1]. */
  peakCorrelation: number;
  /** The best rival at least {@link ALIGN_GUARD_SECONDS} away. */
  rivalCorrelation: number;
  /** `peakCorrelation − rivalCorrelation`. Does ONE lag stand out. */
  prominence: number;
  /** CC2. What the evidence adds up to. See {@link AlignmentOutcome}. */
  outcome: AlignmentOutcome;
  /** `outcome === 'confident'`. Kept as a field so every existing consumer of
   * the boolean keeps compiling and keeps meaning what it meant. */
  confident: boolean;
  /**
   * CC2. The guard-separated lags the surface likes, best first, at most
   * {@link ALIGN_CANDIDATE_COUNT}, separated by at least
   * {@link ALIGN_GUARD_SECONDS} AFTER refinement.
   * `candidates[0].offsetSeconds === offsetSeconds`.
   *
   * Present on `'ambiguous'` and `'weak'` — the two outcomes that are OFFERS —
   * and absent on the other two. `'confident'` has its answer in
   * `offsetSeconds`, and `'unrelated'` has no guess worth showing, which is what
   * the word means. Presence is therefore safe to feature-detect on, though
   * `outcome` remains the dispatch key.
   */
  candidates?: AlignmentCandidate[];
  /**
   * CC2. How fast the take slides against the reference, in seconds per minute,
   * from the straight line fitted through the piecewise window lags. Negative
   * means the take falls progressively BEHIND (it is the slower of the two).
   * Absent when the overlap was too short to cut into
   * {@link ALIGN_PIECEWISE_MIN_WINDOWS} windows.
   *
   * Present even when small: at a drift this arm cannot resolve from timing
   * jitter on a 20 s take the sweep still measured 15–30 ms of placement error,
   * so a caller quoting the module's ±10 ms needs the number rather than a
   * boolean.
   *
   * CC2 fix-round (IMP-4): present only when the windows RAN AND AGREED —
   * `windowsMeasured > 0 && windowLagSpreadSeconds <=
   * {@link ALIGN_MAX_LAG_SPREAD_SECONDS}`, which is a predicate a consumer can
   * compute for itself from two exported quantities. H1: that admits EVERY
   * outcome except `'unrelated'`, which is defined by the windows not agreeing
   * — `'confident'`, the `'weak'` arm that drift itself produced, the `'weak'`
   * arm whose peak simply did not clear, and `'ambiguous'` with agreeing
   * windows. The enumeration here used to name only the first two, so a
   * consumer reading it as the rule would not have expected the field on an
   * `'ambiguous'` result. A slope fitted through windows that scattered across
   * a repeated section, or across four seconds of unrelated audio, is an
   * arbitrary number wearing a unit, and it used to be attached anyway.
   */
  driftSecondsPerMinute?: number;
  /**
   * CC2. How far that drift moves the take from one end of the overlap to the
   * other, in seconds — `|driftSecondsPerMinute| / 60 × overlapSeconds`. This is
   * the quantity the confidence gate is on (see
   * {@link ALIGN_MAX_DRIFT_SPAN_SECONDS}) and the one worth saying out loud:
   * "your take slides 90 ms across the part that overlaps". Present exactly when
   * `driftSecondsPerMinute` is.
   */
  driftSpanSeconds?: number;
  /**
   * CC2. How far the independently-aligned windows disagree once that line is
   * taken out, in seconds — the median deviation from their own median lag.
   * Absent only when the arm could not run at all: unlike the drift pair this
   * one MEANS something when the windows disagree, because it is what the
   * disagreement verdict was made of.
   */
  windowLagSpreadSeconds?: number;
  /** CC2. How many windows the piecewise pass actually aligned. 0 when it could
   * not run. */
  windowsMeasured: number;
  /** What the coarse pass alone said, before the fine pass refined it. Reported
   * because the difference between the two is the only evidence that the
   * refinement stayed inside its window rather than finding a new answer. */
  coarseOffsetSeconds: number;
  /** How many coarse lags carried enough overlap to be evaluated. */
  lagsEvaluated: number;
  /** CC2. How many coarse lags EXIST between the two recordings. */
  lagsTotal: number;
  /**
   * CC2. How much of the lag range the min-overlap gate never looked at, in
   * seconds — `(lagsTotal − lagsEvaluated)` on the coarse frame grid.
   *
   * Reported because a refusal that says "the best alignment found was X" while
   * a fifth of the timeline was never searched is implying a search that did not
   * happen. The gate is deliberate (`ALIGN_MIN_OVERLAP_FRACTION`, and the test
   * that pins a genuine alignment it refuses), but the caller has to be able to
   * say so.
   */
  unevaluatedLagSeconds: number;
  /** The overlap, in seconds, at the winning coarse lag. */
  overlapSeconds: number;
  /**
   * CP1 fix-round. True when a FINE pass produced a surface and `offsetSeconds`
   * is its refined answer; false when none could (too little overlap at the
   * fine grid's own gate) and `offsetSeconds` fell back to the coarse lag.
   *
   * Reported rather than silent because the two carry different accuracy: the
   * ±10 ms this module claims is the refined figure, and a coarse-only answer is
   * one 11.6 ms frame plus interpolation. A caller that quotes an accuracy has to
   * be able to tell which it is holding.
   */
  refined: boolean;
}

/**
 * Linear resampling of an envelope onto a new frame rate. Linear rather than
 * band-limited on purpose: an onset envelope is already a heavily smoothed,
 * locally-mean-rectified curve, and a sinc kernel would ring negative lobes into
 * a quantity whose zeros mean "no attack here".
 */
function resampleEnvelope(env: Float32Array, fromRate: number, toRate: number): Float32Array {
  if (fromRate === toRate) return env;
  const outLen = Math.max(1, Math.floor((env.length * toRate) / fromRate));
  const out = new Float32Array(outLen);
  const step = fromRate / toRate;
  for (let i = 0; i < outLen; i++) {
    const x = i * step;
    const i0 = Math.floor(x);
    const i1 = Math.min(i0 + 1, env.length - 1);
    const f = x - i0;
    out[i] = env[i0] * (1 - f) + env[i1] * f;
  }
  return out;
}

/** The ODF of `mono` at `rate`, or `null` when there is no attack in it —
 * `onsetEnvelope` short-circuits to all-zero below its own 1e-9
 * standard-deviation floor, and a constant envelope has no lag to prefer.
 * `gridRate` of `null` keeps the ODF on its own frame rate. */
function odfOrNull(mono: Float32Array, rate: number, gridRate: number | null): Float32Array | null {
  const { odf, odfRate, numFrames } = onsetEnvelope(mono, rate);
  if (numFrames < 2) return null;
  let nonZero = 0;
  for (let i = 0; i < odf.length; i++) if (odf[i] !== 0) nonZero++;
  if (nonZero === 0) return null;
  const grid = gridRate === null ? odf : resampleEnvelope(odf, odfRate, gridRate);
  return grid.length >= 2 ? grid : null;
}

export interface AlignmentEnvelopes {
  /** On {@link ALIGN_COARSE_FRAME_RATE_HZ}, from the signal brought to
   * {@link ALIGN_ANALYSIS_RATE_HZ}. */
  coarse: Float32Array;
  /** On {@link ALIGN_FRAME_RATE_HZ}, from the signal at its own rate. */
  fine: Float32Array;
}

/**
 * The two onset envelopes this module aligns on — or `null` when there is
 * nothing to align: no samples, a signal shorter than one analysis frame, or
 * audio with no attack anywhere in it.
 *
 * Exported because it is where a refusal is DECIDED, and a refusal the tests
 * cannot reach independently of the correlation is a refusal nobody has checked.
 */
export function alignmentOdf(
  channels: Float32Array[],
  sampleRate: number
): AlignmentEnvelopes | null {
  if (channels.length === 0 || channels[0].length === 0) return null;
  if (!(sampleRate > 0)) return null;
  const mono = monoMix(channels);
  // One hop is the smallest thing `onsetEnvelope` can report a difference
  // across; below one FFT window there is no flux, only the first frame's zero.
  if (mono.length < 1024) return null;

  const analysis =
    sampleRate === ALIGN_ANALYSIS_RATE_HZ
      ? mono
      : resampleChannel(mono, sampleRate, ALIGN_ANALYSIS_RATE_HZ);
  if (analysis.length < 1024) return null;

  // The coarse ODF arrives at ALIGN_ANALYSIS_RATE_HZ / ONSET_HOP = 86.1 fps for
  // EVERY caller, because `analysis` above is at one fixed rate — so the two
  // envelopes being compared already share a grid, and this conversion is not
  // there to reconcile two rates.
  //
  // It is there because 86.1 fps is the wrong grid to SEARCH on. Leaving the
  // coarse ODF at its native rate was measured and lost (worst cover 0.1476
  // against best unrelated 0.1829): a rival search that samples the correlation
  // surface coarsely finds a lower runner-up than the surface really has, which
  // inflates the prominence of a coincidence more than that of an alignment.
  // See ALIGN_COARSE_FRAME_RATE_HZ.
  const coarse = odfOrNull(analysis, ALIGN_ANALYSIS_RATE_HZ, ALIGN_COARSE_FRAME_RATE_HZ);
  if (!coarse) return null;
  const fine = odfOrNull(mono, sampleRate, ALIGN_FRAME_RATE_HZ);
  if (!fine) return null;
  return { coarse, fine };
}

/**
 * CC2. Hann low-pass of an envelope, `ms` wide, edges included by dividing by
 * the weight actually used rather than by the whole kernel — an envelope's ends
 * are real frames, and a kernel that fades them to zero would invent a ramp the
 * correlation then matches against the other signal's ramp.
 *
 * Hann rather than a box: a box's sidelobes put ripple back into the very
 * quantity being smoothed, and the ripple lands at the lag spacing the rival
 * search reads.
 */
export function smoothEnvelope(env: Float32Array, frameRate: number, ms: number): Float32Array {
  if (!(ms > 0)) return env;
  const half = Math.floor((ms * frameRate) / 2000);
  if (half < 1) return env;
  const width = half * 2 + 1;
  const kernel = new Float64Array(width);
  for (let i = 0; i < width; i++) kernel[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * (i + 1)) / (width + 1));
  const out = new Float32Array(env.length);
  for (let i = 0; i < env.length; i++) {
    let acc = 0;
    let weight = 0;
    for (let k = -half; k <= half; k++) {
      const j = i + k;
      if (j < 0 || j >= env.length) continue;
      const w = kernel[k + half];
      acc += env[j] * w;
      weight += w;
    }
    out[i] = weight > 0 ? acc / weight : env[i];
  }
  return out;
}

/** Prefix sums of `v` and of `v²`, as float64 — the Pearson denominators are
 * differences of large partial sums and float32 loses them. */
function prefixSums(v: Float32Array): { sum: Float64Array; sumSq: Float64Array } {
  const n = v.length;
  const sum = new Float64Array(n + 1);
  const sumSq = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) {
    sum[i + 1] = sum[i] + v[i];
    sumSq[i + 1] = sumSq[i] + v[i] * v[i];
  }
  return { sum, sumSq };
}

/**
 * Raw cross-correlation `c[k] = Σ a[i]·b[i−k]` for every lag, via one forward
 * FFT per signal and one inverse. `k` is read modulo `N`, so `c[N−m]` is lag
 * `−m`; `N ≥ La + Lb` keeps the wrap from folding one lag's sum onto another's.
 */
function rawCorrelation(a: Float32Array, b: Float32Array): { c: Float32Array; n: number } {
  const N = nextPow2(a.length + b.length);
  const aRe = new Float32Array(N);
  const aIm = new Float32Array(N);
  const bRe = new Float32Array(N);
  const bIm = new Float32Array(N);
  aRe.set(a);
  bRe.set(b);
  fft(aRe, aIm);
  fft(bRe, bIm);
  // A · conj(B), in place in the a buffers.
  for (let i = 0; i < N; i++) {
    const re = aRe[i] * bRe[i] + aIm[i] * bIm[i];
    const im = aIm[i] * bRe[i] - aRe[i] * bIm[i];
    aRe[i] = re;
    aIm[i] = im;
  }
  ifft(aRe, aIm);
  return { c: aRe, n: N };
}

interface LagSurface {
  /** Pearson correlation per lag, indexed from `kLo`. */
  rho: Float64Array;
  /** Overlap in frames per lag; 0 means "not evaluated". */
  overlap: Int32Array;
  kLo: number;
  bestIdx: number;
  evaluated: number;
}

/**
 * The normalised cross-correlation surface of two envelopes, with the lags that
 * do not overlap by `minOverlap` left unevaluated. `window`, when given,
 * restricts the search to lags within `halfWidth` frames of `centre` — the fine
 * pass's whole safeguard against finding a different verse.
 */
function lagSurface(
  a: Float32Array,
  b: Float32Array,
  minOverlap: number,
  window?: { centre: number; halfWidth: number }
): LagSurface | null {
  const La = a.length;
  const Lb = b.length;
  const { c, n: N } = rawCorrelation(a, b);
  const pa = prefixSums(a);
  const pb = prefixSums(b);

  const kLo = -(Lb - 1);
  const kHi = La - 1;
  const rho = new Float64Array(kHi - kLo + 1);
  const overlap = new Int32Array(kHi - kLo + 1);
  let evaluated = 0;
  let bestIdx = -1;

  for (let k = kLo; k <= kHi; k++) {
    if (window && Math.abs(k - window.centre) > window.halfWidth) continue;
    const idx = k - kLo;
    const iLo = Math.max(0, k);
    const iHi = Math.min(La - 1, Lb - 1 + k);
    const count = iHi - iLo + 1;
    if (count < minOverlap) continue;

    const jLo = iLo - k;
    const jHi = iHi - k;
    const sa = pa.sum[iHi + 1] - pa.sum[iLo];
    const saa = pa.sumSq[iHi + 1] - pa.sumSq[iLo];
    const sb = pb.sum[jHi + 1] - pb.sum[jLo];
    const sbb = pb.sumSq[jHi + 1] - pb.sumSq[jLo];
    const sab = c[k >= 0 ? k : N + k];

    const varA = count * saa - sa * sa;
    const varB = count * sbb - sb * sb;
    if (varA <= 0 || varB <= 0) continue;

    rho[idx] = (count * sab - sa * sb) / Math.sqrt(varA * varB);
    overlap[idx] = count;
    evaluated++;
    if (bestIdx < 0 || rho[idx] > rho[bestIdx]) bestIdx = idx;
  }

  return bestIdx < 0 ? null : { rho, overlap, kLo, bestIdx, evaluated };
}

/**
 * The peak's lag in frames, interpolated parabolically across its two evaluated
 * neighbours. A peak at the very edge of the evaluated range keeps its integer
 * lag rather than extrapolating off the end.
 */
function interpolatedLag(s: LagSurface): number {
  const { rho, overlap, bestIdx, kLo } = s;
  const left = bestIdx - 1;
  const right = bestIdx + 1;
  let delta = 0;
  if (left >= 0 && right < rho.length && overlap[left] > 0 && overlap[right] > 0) {
    const denom = rho[left] - 2 * rho[bestIdx] + rho[right];
    if (denom !== 0) {
      delta = (0.5 * (rho[left] - rho[right])) / denom;
      if (!Number.isFinite(delta) || Math.abs(delta) > 0.5) delta = 0;
    }
  }
  return bestIdx + kLo + delta;
}

/** The best correlation at least `guardFrames` away from the winner, or 0 when
 * no lag outside the guard was evaluable at all — the two recordings are then
 * short enough that the guard swallows the whole surface, nothing stands out
 * relative to nothing, and the correlation floor is what carries the decision. */
function rivalOf(s: LagSurface, guardFrames: number): number {
  let rival = -1;
  for (let idx = 0; idx < s.rho.length; idx++) {
    if (s.overlap[idx] === 0) continue;
    if (Math.abs(idx - s.bestIdx) < guardFrames) continue;
    if (s.rho[idx] > rival) rival = s.rho[idx];
  }
  return rival === -1 ? 0 : rival;
}

/**
 * CC2. The best `count` guard-separated lags, best first — the same greedy walk
 * `rivalOf` does, kept going. Each carries its own prominence: its correlation
 * minus the best evaluated lag at least a guard away FROM IT, so a candidate's
 * number means the same thing the top-level `prominence` means.
 */
function candidatesOf(s: LagSurface, guardFrames: number, count: number): number[] {
  const taken: number[] = [];
  while (taken.length < count) {
    let bestIdx = -1;
    for (let idx = 0; idx < s.rho.length; idx++) {
      if (s.overlap[idx] === 0) continue;
      if (taken.some((t) => Math.abs(idx - t) < guardFrames)) continue;
      if (bestIdx < 0 || s.rho[idx] > s.rho[bestIdx]) bestIdx = idx;
    }
    if (bestIdx < 0) break;
    taken.push(bestIdx);
  }
  return taken;
}

/** The best evaluated lag at least `guardFrames` from `idx`, or 0 when the guard
 * swallows the surface — `rivalOf` for a lag that is not the winner. */
function rivalOfIndex(s: LagSurface, idx: number, guardFrames: number): number {
  let rival = -1;
  for (let i = 0; i < s.rho.length; i++) {
    if (s.overlap[i] === 0) continue;
    if (Math.abs(i - idx) < guardFrames) continue;
    if (s.rho[i] > rival) rival = s.rho[i];
  }
  return rival === -1 ? 0 : rival;
}

/** Median of a copy — the piecewise statistics are medians so that one window
 * landing on a wrong repeat does not become the whole verdict. */
function median(v: number[]): number {
  const sorted = [...v].sort((x, y) => x - y);
  return sorted[Math.floor(sorted.length / 2)];
}

export interface PiecewiseEvidence {
  /** Where each window's own best alignment puts it, in seconds of lag, in take
   * order. */
  windowLagSeconds: number[];
  /** …and the centre of each window in the take's own time. */
  windowCentreSeconds: number[];
  /** Median deviation of those lags from their median. */
  spreadSeconds: number;
  /** The slope of the straight line through them, in seconds per MINUTE. */
  driftSecondsPerMinute: number;
}

/**
 * CC2. The drift-robust half of the evidence: the overlap cut into windows, each
 * aligned to the whole reference INDEPENDENTLY over the full lag range.
 *
 * Independently is the load-bearing word. Searching near the global lag would
 * only ever confirm it — the windows have to be able to disagree, and their
 * disagreement is the signal. Two things come out of the same measurement: how
 * far they scatter (unrelated audio has no lag to agree on, so its windows land
 * seconds apart) and the slope of the line through them, which IS the tempo
 * drift the rigid single-lag model cannot express.
 *
 * `null` when the overlap cannot be cut into {@link ALIGN_PIECEWISE_MIN_WINDOWS}
 * windows of {@link ALIGN_PIECEWISE_WINDOW_SECONDS} — this arm can refuse, but
 * it can never be the reason something is believed, so being unable to run must
 * not be read as agreement.
 */
export function piecewiseEvidence(
  reference: Float32Array,
  take: Float32Array,
  bestLagFrames: number,
  frameRate: number
): PiecewiseEvidence | null {
  const La = reference.length;
  const Lb = take.length;
  const iLo = Math.max(0, bestLagFrames);
  const iHi = Math.min(La - 1, Lb - 1 + bestLagFrames);
  const jLo = iLo - bestLagFrames;
  const overlapFrames = iHi - iLo + 1;
  if (overlapFrames <= 0) return null;

  const windowFrames = Math.round(ALIGN_PIECEWISE_WINDOW_SECONDS * frameRate);
  const windows = Math.min(
    ALIGN_PIECEWISE_MAX_WINDOWS,
    Math.floor(overlapFrames / windowFrames)
  );
  if (windows < ALIGN_PIECEWISE_MIN_WINDOWS) return null;
  const span = Math.floor(overlapFrames / windows);
  if (span > La) return null;

  const pa = prefixSums(reference);
  const windowLagSeconds: number[] = [];
  const windowCentreSeconds: number[] = [];

  for (let w = 0; w < windows; w++) {
    const j0 = jLo + w * span;
    const slice = take.subarray(j0, j0 + span);
    const pb = prefixSums(slice);
    const sb = pb.sum[span];
    const sbb = pb.sumSq[span];
    const varB = span * sbb - sb * sb;
    if (varB <= 0) return null;

    const { c, n: N } = rawCorrelation(reference, slice);
    let best = -Infinity;
    let bestStart = -1;
    for (let i0 = 0; i0 + span <= La; i0++) {
      const sa = pa.sum[i0 + span] - pa.sum[i0];
      const saa = pa.sumSq[i0 + span] - pa.sumSq[i0];
      const varA = span * saa - sa * sa;
      if (varA <= 0) continue;
      const sab = c[i0];
      const rho = (span * sab - sa * sb) / Math.sqrt(varA * varB);
      if (rho > best) {
        best = rho;
        bestStart = i0;
      }
    }
    if (bestStart < 0) return null;
    windowLagSeconds.push((bestStart - j0) / frameRate);
    windowCentreSeconds.push((j0 + span / 2) / frameRate);
  }

  const mid = median(windowLagSeconds);
  const spreadSeconds = median(windowLagSeconds.map((l) => Math.abs(l - mid)));

  // Least squares through (centre, lag). The slope is seconds of lag per second
  // of take; a minute is the unit a drift is worth saying out loud in.
  const meanT = windowCentreSeconds.reduce((a, t) => a + t, 0) / windows;
  const meanL = windowLagSeconds.reduce((a, l) => a + l, 0) / windows;
  let num = 0;
  let den = 0;
  for (let w = 0; w < windows; w++) {
    num += (windowCentreSeconds[w] - meanT) * (windowLagSeconds[w] - meanL);
    den += (windowCentreSeconds[w] - meanT) ** 2;
  }
  const slope = den > 0 ? num / den : 0;

  return {
    windowLagSeconds,
    windowCentreSeconds,
    spreadSeconds,
    driftSecondsPerMinute: slope * 60,
  };
}

function minOverlapFrames(La: number, Lb: number, frameRate: number): number {
  return Math.max(
    Math.round(ALIGN_MIN_OVERLAP_SECONDS * frameRate),
    Math.round(Math.min(La, Lb) * ALIGN_MIN_OVERLAP_FRACTION)
  );
}

/**
 * Aligns `take` to `reference` globally, or refuses.
 *
 * Returns `null` when the question cannot be asked — either side with no onset
 * at all, or two recordings that cannot overlap by
 * {@link ALIGN_MIN_OVERLAP_SECONDS}. A refusal on CONFIDENCE is not a `null`:
 * it comes back as a measurement with `confident: false` and the numbers that
 * decided it, because the caller has to be able to say why.
 */
export function alignTakeToReference(
  reference: Float32Array[],
  referenceRate: number,
  take: Float32Array[],
  takeRate: number
): AlignmentMeasurement | null {
  const a = alignmentOdf(reference, referenceRate);
  const b = alignmentOdf(take, takeRate);
  if (!a || !b) return null;
  return alignEnvelopes({ a, b });
}

/**
 * CC2. The correlation half of {@link alignTakeToReference}, taking the two
 * envelope pairs directly.
 *
 * Exported for the same reason `alignmentOdf` is: the DERIVATION has to run
 * over one set of envelopes at many smoothing widths, and re-rendering and
 * re-framing twenty seconds of audio per width would make the sweep that
 * chooses {@link ALIGN_SMOOTHING_MS} unaffordable — so the constant would have
 * gone back to being a preference. `smoothingMs` defaults to the shipped width;
 * passing another is what the sweep does and nothing else should.
 */
export function alignEnvelopes(
  pair: { a: AlignmentEnvelopes; b: AlignmentEnvelopes },
  smoothingMs: number = ALIGN_SMOOTHING_MS
): AlignmentMeasurement | null {
  const { a, b } = pair;
  const coarseMin = minOverlapFrames(
    a.coarse.length,
    b.coarse.length,
    ALIGN_COARSE_FRAME_RATE_HZ
  );
  if (Math.min(a.coarse.length, b.coarse.length) < coarseMin) return null;

  const aCoarse = smoothEnvelope(a.coarse, ALIGN_COARSE_FRAME_RATE_HZ, smoothingMs);
  const bCoarse = smoothEnvelope(b.coarse, ALIGN_COARSE_FRAME_RATE_HZ, smoothingMs);

  const coarse = lagSurface(aCoarse, bCoarse, coarseMin);
  if (!coarse) return null;

  const guardFrames = Math.round(ALIGN_GUARD_SECONDS * ALIGN_COARSE_FRAME_RATE_HZ);
  const peak = coarse.rho[coarse.bestIdx];
  const rival = rivalOf(coarse, guardFrames);
  const prominence = peak - rival;
  const coarseOffsetSeconds = interpolatedLag(coarse) / ALIGN_COARSE_FRAME_RATE_HZ;

  // The fine pass never gets to disagree about WHICH alignment this is — only
  // about where inside ±ALIGN_REFINE_SECONDS of it the peak really sits. It runs
  // on UNSMOOTHED envelopes: the coarse pass has already decided which alignment
  // this is, and blurring the pass whose whole job is precision would spend the
  // ±10 ms for nothing.
  const fineMin = minOverlapFrames(a.fine.length, b.fine.length, ALIGN_FRAME_RATE_HZ);

  /**
   * THE refinement entry point — the winner and every candidate go through this
   * one function, so whatever the user ends up placing has been refined the same
   * way. Two arms that each refined their own way is exactly how a row comes to
   * promise −8.257 s while −8.243 s is placed.
   */
  const refine = (coarseSeconds: number): number => {
    const surface = lagSurface(a.fine, b.fine, fineMin, {
      centre: coarseSeconds * ALIGN_FRAME_RATE_HZ,
      halfWidth: ALIGN_REFINE_SECONDS * ALIGN_FRAME_RATE_HZ,
    });
    return surface ? interpolatedLag(surface) / ALIGN_FRAME_RATE_HZ : NaN;
  };

  const refinedBest = refine(coarseOffsetSeconds);
  const refined = Number.isFinite(refinedBest);
  const offsetSeconds = refined ? refinedBest : coarseOffsetSeconds;

  // Every candidate is refined the same way the winner is, so a caller offering
  // the user a choice is offering three answers of one accuracy rather than one
  // good one and two coarse ones.
  //
  // CC2 fix-round (IMP-2): and the separation is enforced AFTER refinement, not
  // assumed from before it. The coarse walk picks lags at least a guard apart,
  // but each is then moved independently by up to ±ALIGN_REFINE_SECONDS — two
  // candidates 0.35 s apart could in principle converge, and a picker offering
  // two near-identical "choices" is worse than offering one. Measured, the
  // refinement moves up to 39 ms and this filter drops nothing; it exists so
  // that a future change to the fine pass cannot make the contract quietly
  // false.
  const candidates: AlignmentCandidate[] = [];
  for (const [rank, idx] of candidatesOf(coarse, guardFrames, ALIGN_CANDIDATE_COUNT).entries()) {
    const lagSeconds =
      rank === 0 ? coarseOffsetSeconds : (idx + coarse.kLo) / ALIGN_COARSE_FRAME_RATE_HZ;
    // Rank 0 IS the winner, whose refinement has already been paid for.
    const candidateRefined = rank === 0 ? refinedBest : refine(lagSeconds);
    const offset = Number.isFinite(candidateRefined) ? candidateRefined : lagSeconds;
    if (candidates.some((c) => Math.abs(c.offsetSeconds - offset) < ALIGN_GUARD_SECONDS)) continue;
    candidates.push({
      offsetSeconds: offset,
      correlation: coarse.rho[idx],
      prominence: coarse.rho[idx] - rivalOfIndex(coarse, idx, guardFrames),
    });
  }

  const piecewise = piecewiseEvidence(
    aCoarse,
    bCoarse,
    coarse.bestIdx + coarse.kLo,
    ALIGN_COARSE_FRAME_RATE_HZ
  );

  // ── The verdict ───────────────────────────────────────────────────────────
  // Order matters, and it is an argument rather than a preference. AMBIGUITY is
  // asked first: when several lags match equally well the windows disagreeing is
  // a SYMPTOM of that, not separate evidence, and reading it as disagreement
  // would report "your take does not hold one lag" about a take that holds three
  // of them perfectly.
  const peakClears = peak >= ALIGN_MIN_CORRELATION;
  const windowsAgree =
    piecewise === null || piecewise.spreadSeconds <= ALIGN_MAX_LAG_SPREAD_SECONDS;
  const overlapSeconds = coarse.overlap[coarse.bestIdx] / ALIGN_COARSE_FRAME_RATE_HZ;
  const driftSpanSeconds =
    piecewise === null
      ? undefined
      : (Math.abs(piecewise.driftSecondsPerMinute) / 60) * overlapSeconds;
  const drifts = driftSpanSeconds !== undefined && driftSpanSeconds > ALIGN_MAX_DRIFT_SPAN_SECONDS;
  const measuredAgreement = piecewise !== null && windowsAgree;
  // CC2 fix-round (IMP-3): the gap zone. A peak above every unrelated pair the
  // sweep can build is evidence in itself — but only while the second arm is
  // SILENT. Windows that ran and disagreed are evidence against, and outrank it.
  const aboveUnrelatedBand = peak >= ALIGN_WEAK_CORRELATION && piecewise === null;

  let outcome: AlignmentOutcome;
  if (!peakClears && !measuredAgreement && !aboveUnrelatedBand) outcome = 'unrelated';
  else if (peakClears && prominence < ALIGN_MIN_PROMINENCE) outcome = 'ambiguous';
  else if (peakClears && windowsAgree && !drifts) outcome = 'confident';
  else outcome = 'weak';

  // CC2 fix-round (IMP-4): a field is present only where its value MEANS
  // something, so that a consumer feature-detecting on presence cannot be told
  // something false. `candidates` goes to the two outcomes that are offers —
  // 'ambiguous' (pick one of these) and 'weak' (here is the guess and its
  // alternatives). 'confident' already has its answer in `offsetSeconds`, and
  // 'unrelated' has no guess worth showing, which is the whole meaning of the
  // word. The drift pair is gated on the windows AGREEING: a slope fitted
  // through windows that scattered across a repeated section or across four
  // seconds of unrelated audio is an arbitrary number wearing a unit.
  const offersCandidates = outcome === 'ambiguous' || outcome === 'weak';
  const driftIsMeaningful = piecewise !== null && windowsAgree;

  return {
    offsetSeconds,
    peakCorrelation: peak,
    rivalCorrelation: rival,
    prominence,
    outcome,
    confident: outcome === 'confident',
    ...(offersCandidates ? { candidates } : {}),
    ...(driftIsMeaningful
      ? { driftSecondsPerMinute: piecewise.driftSecondsPerMinute, driftSpanSeconds }
      : {}),
    // The spread is the ONE piecewise field whose meaning survives
    // disagreement: it is what the disagreement verdict was made of, so it is
    // reported whenever the arm spoke at all.
    ...(piecewise ? { windowLagSpreadSeconds: piecewise.spreadSeconds } : {}),
    windowsMeasured: piecewise ? piecewise.windowLagSeconds.length : 0,
    coarseOffsetSeconds,
    lagsEvaluated: coarse.evaluated,
    lagsTotal: coarse.rho.length,
    unevaluatedLagSeconds:
      (coarse.rho.length - coarse.evaluated) / ALIGN_COARSE_FRAME_RATE_HZ,
    overlapSeconds,
    refined,
  };
}
