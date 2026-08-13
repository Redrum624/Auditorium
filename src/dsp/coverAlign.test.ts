import {
  ALIGN_ANALYSIS_RATE_HZ,
  ALIGN_COARSE_FRAME_RATE_HZ,
  ALIGN_FRAME_RATE_HZ,
  ALIGN_GUARD_SECONDS,
  ALIGN_MIN_CORRELATION,
  ALIGN_MIN_OVERLAP_SECONDS,
  ALIGN_MIN_PROMINENCE,
  ALIGN_REFINE_SECONDS,
  alignmentOdf,
  alignTakeToReference,
} from './coverAlign';
import { makeVocalLike } from './__fixtures__/coverAlignFixtures';

const RATE = 44100;
const SECONDS = 10;

/** The acceptance the brief states: a known offset recovered to within 10 ms. */
const TOLERANCE_SECONDS = 0.01;

describe('alignmentOdf', () => {
  it('lands both envelopes on their common frame grids whatever the source rate', () => {
    const a = alignmentOdf(makeVocalLike({ seed: 1, sampleRate: 44100, seconds: 4 }), 44100);
    const b = alignmentOdf(makeVocalLike({ seed: 1, sampleRate: 48000, seconds: 4 }), 48000);
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    // A 44.1 kHz file and a 48 kHz file must produce the same number of frames
    // for the same four seconds, or every lag would carry a rate-dependent bias.
    expect(Math.abs(a!.fine.length - b!.fine.length)).toBeLessThanOrEqual(1);
    expect(Math.abs(a!.coarse.length - b!.coarse.length)).toBeLessThanOrEqual(1);
    expect(a!.fine.length).toBeGreaterThan(4 * ALIGN_FRAME_RATE_HZ * 0.8);
    expect(a!.coarse.length).toBeGreaterThan(4 * ALIGN_COARSE_FRAME_RATE_HZ * 0.8);
    // The two passes share ONE grid on purpose (see the constant's note), so
    // the coarse offset can be handed to the fine pass as a window with no
    // units conversion. What differs between them is the ANALYSIS rate.
    expect(ALIGN_COARSE_FRAME_RATE_HZ).toBe(ALIGN_FRAME_RATE_HZ);
    expect(ALIGN_ANALYSIS_RATE_HZ).toBeLessThan(44100);
  });

  it('returns null for silence — there is no onset to align on', () => {
    expect(alignmentOdf([new Float32Array(RATE * 3)], RATE)).toBeNull();
  });

  it('returns null for a signal too short to frame', () => {
    expect(alignmentOdf([new Float32Array(16)], RATE)).toBeNull();
  });
});

describe('alignTakeToReference — ground truth', () => {
  it('recovers a positive offset (the take starts later than the reference)', () => {
    const reference = makeVocalLike({ seed: 7, sampleRate: RATE, seconds: SECONDS, leadSeconds: 1.4 });
    const take = makeVocalLike({ seed: 7, sampleRate: RATE, seconds: SECONDS, leadSeconds: 0.2 });
    const result = alignTakeToReference(reference, RATE, take, RATE);
    expect(result).not.toBeNull();
    // offset = the take's sample 0 on the reference's timeline = 1.4 − 0.2.
    expect(result!.offsetSeconds).toBeCloseTo(1.2, 2);
    expect(Math.abs(result!.offsetSeconds - 1.2)).toBeLessThan(TOLERANCE_SECONDS);
    expect(result!.confident).toBe(true);
  });

  it('recovers a negative offset (the take starts earlier than the reference)', () => {
    const reference = makeVocalLike({ seed: 11, sampleRate: RATE, seconds: SECONDS, leadSeconds: 0.3 });
    const take = makeVocalLike({ seed: 11, sampleRate: RATE, seconds: SECONDS, leadSeconds: 1.05 });
    const result = alignTakeToReference(reference, RATE, take, RATE);
    expect(result).not.toBeNull();
    expect(Math.abs(result!.offsetSeconds - -0.75)).toBeLessThan(TOLERANCE_SECONDS);
    expect(result!.confident).toBe(true);
  });

  it('recovers a zero offset without inventing one', () => {
    const reference = makeVocalLike({ seed: 3, sampleRate: RATE, seconds: SECONDS, leadSeconds: 0.5 });
    const take = makeVocalLike({ seed: 3, sampleRate: RATE, seconds: SECONDS, leadSeconds: 0.5 });
    const result = alignTakeToReference(reference, RATE, take, RATE);
    expect(result).not.toBeNull();
    expect(Math.abs(result!.offsetSeconds)).toBeLessThan(TOLERANCE_SECONDS);
    expect(result!.confident).toBe(true);
  });

  it('recovers an offset across different sample rates', () => {
    const reference = makeVocalLike({ seed: 21, sampleRate: 44100, seconds: SECONDS, leadSeconds: 0.8 });
    const take = makeVocalLike({ seed: 21, sampleRate: 48000, seconds: SECONDS, leadSeconds: 0.15 });
    const result = alignTakeToReference(reference, 44100, take, 48000);
    expect(result).not.toBeNull();
    expect(Math.abs(result!.offsetSeconds - 0.65)).toBeLessThan(TOLERANCE_SECONDS);
    expect(result!.confident).toBe(true);
  });

  it('recovers the offset of a DIFFERENT performance of the same phrasing', () => {
    // The case that actually ships: the same words at other pitches, other
    // dynamics, with noise on top — a cover, not a copy.
    const reference = makeVocalLike({ seed: 33, sampleRate: 44100, seconds: SECONDS, leadSeconds: 1.0 });
    const take = makeVocalLike({
      seed: 33,
      sampleRate: 48000,
      seconds: SECONDS,
      leadSeconds: 0.38,
      hzScale: 1.335,
      amplitudeJitter: 0.45,
      noiseAmplitude: 0.01,
      varianceSeed: 9001,
    });
    const result = alignTakeToReference(reference, 44100, take, 48000);
    expect(result).not.toBeNull();
    expect(Math.abs(result!.offsetSeconds - 0.62)).toBeLessThan(TOLERANCE_SECONDS);
    expect(result!.confident).toBe(true);
  });

  it('recovers a stereo take against a stereo reference', () => {
    const reference = makeVocalLike({
      seed: 41, sampleRate: RATE, seconds: SECONDS, leadSeconds: 0.9, channels: 2,
    });
    const take = makeVocalLike({
      seed: 41, sampleRate: RATE, seconds: SECONDS, leadSeconds: 0.4, channels: 2,
    });
    const result = alignTakeToReference(reference, RATE, take, RATE);
    expect(Math.abs(result!.offsetSeconds - 0.5)).toBeLessThan(TOLERANCE_SECONDS);
  });
});

describe('alignTakeToReference — refusal', () => {
  it('refuses audio with no relation to the reference', () => {
    const reference = makeVocalLike({ seed: 101, sampleRate: RATE, seconds: SECONDS, leadSeconds: 0.5 });
    const take = makeVocalLike({ seed: 500, sampleRate: RATE, seconds: SECONDS, leadSeconds: 0.5 });
    const result = alignTakeToReference(reference, RATE, take, RATE);
    expect(result).not.toBeNull();
    expect(result!.confident).toBe(false);
    // The refusal has to carry the numbers that produced it — the stage's copy
    // quotes them, and a bare boolean cannot be argued with.
    expect(Number.isFinite(result!.peakCorrelation)).toBe(true);
    expect(Number.isFinite(result!.prominence)).toBe(true);
  });

  it('returns null when either side has no onset at all', () => {
    const reference = makeVocalLike({ seed: 5, sampleRate: RATE, seconds: SECONDS });
    expect(alignTakeToReference(reference, RATE, [new Float32Array(RATE * 5)], RATE)).toBeNull();
    expect(alignTakeToReference([new Float32Array(RATE * 5)], RATE, reference, RATE)).toBeNull();
  });

  it('returns null when the two are too short to overlap by the stated minimum', () => {
    const reference = makeVocalLike({ seed: 5, sampleRate: RATE, seconds: SECONDS });
    const stub = makeVocalLike({ seed: 5, sampleRate: RATE, seconds: ALIGN_MIN_OVERLAP_SECONDS * 0.4 });
    expect(alignTakeToReference(reference, RATE, stub, RATE)).toBeNull();
  });
});

/**
 * Where the two thresholds COME FROM.
 *
 * This is not a scratch harness that ran once and was thrown away — it is the
 * derivation, kept, so `ALIGN_MIN_PROMINENCE` and `ALIGN_MIN_CORRELATION` can
 * be re-derived by anyone who changes the DSP under them. Sixteen constructed
 * cover pairs (one syllable schedule, sung at pitches scaled 1.26×, with ±50 %
 * dynamics jitter and noise, 44.1 kHz against 48 kHz) against sixteen pairs
 * with no relation at all. It PRINTS both populations and then asserts the
 * shipped constants still sit strictly inside the gap between them, so a change
 * that narrows the gap fails here rather than in front of a user.
 */
describe('alignTakeToReference — the measured separation', () => {
  const SEEDS = 16;
  const SWEEP_SECONDS = 10;
  const SWEEP_OFFSET = 0.6;

  function sweepPair(referenceSeed: number, takeSeed: number, varianceSeed: number) {
    const reference = makeVocalLike({
      seed: referenceSeed,
      sampleRate: 44100,
      seconds: SWEEP_SECONDS,
      leadSeconds: 0.9,
    });
    const take = makeVocalLike({
      seed: takeSeed,
      sampleRate: 48000,
      seconds: SWEEP_SECONDS,
      leadSeconds: 0.3,
      hzScale: 1.26,
      amplitudeJitter: 0.5,
      noiseAmplitude: 0.012,
      varianceSeed,
    });
    return alignTakeToReference(reference, 44100, take, 48000);
  }

  /** Same schedule, different performance — a cover. */
  const related = (seed: number) => sweepPair(seed, seed, seed * 7 + 3);
  /** A schedule with nothing to do with the reference's. */
  const unrelated = (seed: number) => sweepPair(seed, seed + 7919, seed * 13 + 5);

  const span = (v: number[]) => ({
    min: Number(Math.min(...v).toFixed(4)),
    max: Number(Math.max(...v).toFixed(4)),
  });

  it('separates covers from unrelated audio, and both thresholds sit in the gap', () => {
    const relatedProminence: number[] = [];
    const relatedPeak: number[] = [];
    const relatedError: number[] = [];
    const relatedRefinement: number[] = [];
    const unrelatedProminence: number[] = [];
    const unrelatedPeak: number[] = [];

    for (let s = 0; s < SEEDS; s++) {
      const r = related(1000 + s);
      expect(r).not.toBeNull();
      relatedProminence.push(r!.prominence);
      relatedPeak.push(r!.peakCorrelation);
      relatedError.push(Math.abs(r!.offsetSeconds - SWEEP_OFFSET));
      relatedRefinement.push(Math.abs(r!.offsetSeconds - r!.coarseOffsetSeconds));

      const u = unrelated(2000 + s);
      expect(u).not.toBeNull();
      unrelatedProminence.push(u!.prominence);
      unrelatedPeak.push(u!.peakCorrelation);
    }

    // The derivation, printed. `ALIGN_MIN_PROMINENCE` and
    // `ALIGN_MIN_CORRELATION` are points inside these gaps.
    // eslint-disable-next-line no-console
    console.log(
      [
        `cover prominence      ${JSON.stringify(span(relatedProminence))}`,
        `unrelated prominence  ${JSON.stringify(span(unrelatedProminence))}`,
        `cover correlation     ${JSON.stringify(span(relatedPeak))}`,
        `unrelated correlation ${JSON.stringify(span(unrelatedPeak))}`,
        `cover offset error s  ${JSON.stringify(span(relatedError))}`,
        `refinement moved s    ${JSON.stringify(span(relatedRefinement))}`,
      ].join('\n  ')
    );

    const worstRelatedProminence = Math.min(...relatedProminence);
    const bestUnrelatedProminence = Math.max(...unrelatedProminence);
    const worstRelatedPeak = Math.min(...relatedPeak);
    const bestUnrelatedPeak = Math.max(...unrelatedPeak);

    // The gaps themselves, so a regression reads as a number rather than as a
    // boolean that flipped.
    expect(bestUnrelatedProminence).toBeLessThan(worstRelatedProminence);
    expect(ALIGN_MIN_PROMINENCE).toBeGreaterThan(bestUnrelatedProminence);
    expect(ALIGN_MIN_PROMINENCE).toBeLessThan(worstRelatedProminence);
    expect(bestUnrelatedPeak).toBeLessThan(worstRelatedPeak);
    expect(ALIGN_MIN_CORRELATION).toBeGreaterThan(bestUnrelatedPeak);
    expect(ALIGN_MIN_CORRELATION).toBeLessThan(worstRelatedPeak);

    // The fine pass is a REFINEMENT, not a second opinion: it may never leave
    // the window the coarse pass handed it.
    expect(Math.max(...relatedRefinement)).toBeLessThanOrEqual(ALIGN_REFINE_SECONDS);

    // The ±10 ms requirement is pinned by the ground-truth cases above, where
    // the take IS the reference at a known offset and the answer is not a
    // matter of opinion. THIS population is harder and its residual is stated
    // rather than asserted away: two different performances of one schedule
    // disagree about where a syllable starts, and the sweep measured 6.6–10.4 ms
    // of that disagreement. 15 ms is a ceiling on the disagreement, not a
    // restatement of the requirement.
    expect(Math.max(...relatedError)).toBeLessThan(0.015);
  });

  it('every related pair is accepted and every unrelated pair refused', () => {
    for (let s = 0; s < SEEDS; s++) {
      expect(related(1000 + s)!.confident).toBe(true);
      expect(unrelated(2000 + s)!.confident).toBe(false);
    }
  });
});

describe('the published constants', () => {
  it('states a guard wide enough to skip the peak\'s own shoulders', () => {
    expect(ALIGN_GUARD_SECONDS).toBeGreaterThan(0.2);
    expect(ALIGN_MIN_OVERLAP_SECONDS).toBeGreaterThanOrEqual(1);
    expect(ALIGN_FRAME_RATE_HZ).toBeGreaterThanOrEqual(100);
  });
});
