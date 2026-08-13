import {
  ALIGN_ANALYSIS_RATE_HZ,
  ALIGN_COARSE_FRAME_RATE_HZ,
  ALIGN_FRAME_RATE_HZ,
  ALIGN_GUARD_SECONDS,
  ALIGN_MIN_CORRELATION,
  ALIGN_MIN_OVERLAP_FRACTION,
  ALIGN_MIN_OVERLAP_SECONDS,
  ALIGN_MIN_PROMINENCE,
  ALIGN_CORRELATION_MARGIN,
  ALIGN_PROMINENCE_MARGIN,
  ALIGN_REFINE_SECONDS,
  alignmentOdf,
  alignTakeToReference,
} from './coverAlign';
import { BANDS, computeBandTable } from './tempoCore';
import {
  makeVocalLike,
  perturbSchedule,
  syllableSchedule,
} from './__fixtures__/coverAlignFixtures';

const RATE = 44100;
const SECONDS = 10;

/** The acceptance the brief states: a known offset recovered to within 10 ms. */
const TOLERANCE_SECONDS = 0.01;

/**
 * CC2. The calibration population's timing was SAMPLE-IDENTICAL — same seed,
 * same schedule, same onsets to the sample — so nothing in the shipped floors
 * ever saw a human being early on one word and late on the next. These are the
 * knobs that make a constructed take a PERFORMANCE rather than a copy, and they
 * are pinned here because every threshold below is derived from populations
 * they generate: a knob that quietly did nothing would silently turn the whole
 * derivation back into the sample-identical sweep it exists to replace.
 */
describe('the fixture\'s timing knobs', () => {
  const base = syllableSchedule(1234, 20);

  it('moves every syllable by at most the stated jitter, and really moves them', () => {
    const jitter = 0.04;
    const jittered = perturbSchedule(base, { timingJitterSeconds: jitter, timingSeed: 5 });
    expect(jittered).toHaveLength(base.length);
    const moves = jittered.map((s, i) => s.startSeconds - base[i].startSeconds);
    // Bounded by the knob…
    expect(Math.max(...moves.map(Math.abs))).toBeLessThanOrEqual(jitter + 1e-9);
    // …and a uniform ±40 ms draw has SD 40/√3 = 23.1 ms. Asserting the SPREAD
    // rather than "something moved" is what catches a knob wired to a stream
    // that always returns the same number.
    const sd = Math.sqrt(moves.reduce((a, m) => a + m * m, 0) / moves.length);
    expect(sd).toBeGreaterThan((jitter / Math.sqrt(3)) * 0.6);
    expect(sd).toBeLessThan(jitter);
    // Deterministic: same seed, same schedule.
    expect(perturbSchedule(base, { timingJitterSeconds: jitter, timingSeed: 5 })).toEqual(jittered);
  });

  it('scales start times by the tempo knob, so the error grows with time', () => {
    const drifted = perturbSchedule(base, { tempoScale: 1.005 });
    for (const [i, s] of drifted.entries()) {
      expect(s.startSeconds).toBeCloseTo(base[i].startSeconds * 1.005, 9);
      // Durations are NOT scaled: a singer drifting against a click changes
      // WHEN a syllable starts, and the onset envelope keys on starts.
      expect(s.durationSeconds).toBe(base[i].durationSeconds);
    }
    const last = drifted[drifted.length - 1].startSeconds - base[base.length - 1].startSeconds;
    const first = drifted[0].startSeconds - base[0].startSeconds;
    expect(last).toBeGreaterThan(first);
  });

  it('tiles one period when asked for a repeated section', () => {
    const period = 8;
    const repeated = syllableSchedule(77, period * 3, 0, period);
    const inFirst = repeated.filter((s) => s.startSeconds < period);
    expect(inFirst.length).toBeGreaterThan(3);
    // Every syllable of period 1 has a twin exactly one period later — the
    // self-similarity a chorus gives a correlation surface.
    for (const s of inFirst) {
      const twin = repeated.find((t) => Math.abs(t.startSeconds - (s.startSeconds + period)) < 1e-9);
      expect(twin).toBeDefined();
      expect(twin!.hz).toBeCloseTo(s.hz, 9);
    }
    expect(repeated.length).toBe(inFirst.length * 3);
  });

  it('renders the knobs into the audio, not just into the schedule', () => {
    const plain = makeVocalLike({ seed: 9, sampleRate: RATE, seconds: 6 });
    const jittered = makeVocalLike({
      seed: 9,
      sampleRate: RATE,
      seconds: 6,
      timingJitterSeconds: 0.04,
      timingSeed: 3,
    });
    expect(jittered[0].length).toBe(plain[0].length);
    let diff = 0;
    for (let i = 0; i < plain[0].length; i++) diff += Math.abs(plain[0][i] - jittered[0][i]);
    expect(diff).toBeGreaterThan(0);
    // …and with the knobs at their defaults the fixture is bit-identical to
    // what the shipped calibration measured, so this commit moves no floor.
    const same = makeVocalLike({ seed: 9, sampleRate: RATE, seconds: 6 });
    expect(Array.from(same[0])).toEqual(Array.from(plain[0]));
  });
});

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

  it('recovers a genuinely stereo take against a genuinely stereo reference', () => {
    // CP1 fix-round: `channels: 2` alone is DUAL-MONO, which `monoMix` collapses
    // back to exactly the mono case — so it proved nothing about stereo. These
    // two differ per channel (a second, decorrelated performance in the right),
    // which is what a real stereo recording hands the downmix.
    const stereo = (seed: number, leadSeconds: number): Float32Array[] => {
      const left = makeVocalLike({ seed, sampleRate: RATE, seconds: SECONDS, leadSeconds });
      const right = makeVocalLike({
        seed,
        sampleRate: RATE,
        seconds: SECONDS,
        leadSeconds,
        hzScale: 1.19,
        amplitudeJitter: 0.3,
        varianceSeed: seed * 3 + 11,
      });
      return [left[0], right[0]];
    };
    const reference = stereo(41, 0.9);
    const take = stereo(41, 0.4);
    const result = alignTakeToReference(reference, RATE, take, RATE);
    expect(result).not.toBeNull();
    expect(Math.abs(result!.offsetSeconds - 0.5)).toBeLessThan(TOLERANCE_SECONDS);
    expect(result!.confident).toBe(true);
  });

  /**
   * CP1 fix-round (I10). The ±10 ms above is measured at ONE gain, and the
   * measurement that says so: at unity the error is 8.4 ms, at −40 dB it is
   * 10.9 ms — past the tolerance the rest of this suite asserts — and at −70 dB
   * it is 21.6 ms, with prominence eroding 0.474 → 0.379 across the same range.
   *
   * −40 dB is the level pinned here because it is the one where the claim
   * BREAKS: pinning unity would assert only that the good case is good, and
   * pinning −70 dB would pin a level no usable take sits at. The assertion is
   * therefore the honest one — the offset is still recovered to within 15 ms and
   * the alignment is still BELIEVED — rather than the ±10 ms the louder cases
   * meet. A quiet take degrades this measurement; it does not break it, and the
   * boundary is here rather than in a user's session.
   */
  it('degrades but still recovers and still believes a very quiet take', () => {
    const scale = (chs: Float32Array[], g: number): Float32Array[] =>
      chs.map((c) => Float32Array.from(c, (v) => v * g));
    const reference = makeVocalLike({ seed: 7, sampleRate: RATE, seconds: SECONDS, leadSeconds: 1.4 });
    const take = makeVocalLike({ seed: 7, sampleRate: RATE, seconds: SECONDS, leadSeconds: 0.2 });
    const quiet = scale(take, Math.pow(10, -40 / 20));

    const loud = alignTakeToReference(reference, RATE, take, RATE)!;
    const result = alignTakeToReference(reference, RATE, quiet, RATE);
    expect(result).not.toBeNull();
    expect(Math.abs(result!.offsetSeconds - 1.2)).toBeLessThan(0.015);
    expect(result!.confident).toBe(true);
    // The direction of the degradation is part of the claim: quieter is worse,
    // never better, so a future change that "improves" the quiet case is a
    // change to investigate rather than to celebrate.
    expect(result!.prominence).toBeLessThanOrEqual(loud.prominence + 1e-9);
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
    // CP1 fix-round: the two fields nothing pinned. `rivalCorrelation` is what
    // makes `prominence` a comparison rather than a bare score, and
    // `overlapSeconds` is how much audio the verdict was formed over — a caller
    // quoting either would have been quoting an unchecked number.
    expect(result!.prominence).toBeCloseTo(result!.peakCorrelation - result!.rivalCorrelation, 12);
    expect(result!.overlapSeconds).toBeGreaterThan(ALIGN_MIN_OVERLAP_SECONDS);
    expect(result!.overlapSeconds).toBeLessThanOrEqual(SECONDS + 1);
  });

  /**
   * CP1 fix-round: the `rival === -1 -> 0` no-op. When the guard swallows the
   * whole evaluable surface there is no rival to compare against, so prominence
   * degenerates to the peak itself and the CORRELATION floor is the only thing
   * carrying the decision. `lagsEvaluated` is what tells a caller the surface
   * was that small, and nothing asserted it.
   */
  it('reports how small the surface was when the guard leaves no rival', () => {
    const reference = makeVocalLike({ seed: 5, sampleRate: RATE, seconds: SECONDS });
    const result = alignTakeToReference(reference, RATE, reference, RATE)!;
    expect(result.lagsEvaluated).toBeGreaterThan(0);
    // A signal against ITSELF: peak is 1 at lag 0 by construction.
    expect(result.peakCorrelation).toBeCloseTo(1, 6);
    expect(Math.abs(result.offsetSeconds)).toBeLessThan(TOLERANCE_SECONDS);
    // Every evaluated lag is a real lag of the surface, never more than exist.
    expect(result.lagsEvaluated).toBeLessThanOrEqual(
      Math.round((SECONDS * 2 + 2) * ALIGN_FRAME_RATE_HZ)
    );
  });

  /** CP1 fix-round: the fine pass either ran or it did not, and the accuracy the
   * caller may quote depends on which. It was silent before. */
  it('says whether the answer was refined by the fine pass', () => {
    const reference = makeVocalLike({ seed: 7, sampleRate: RATE, seconds: SECONDS, leadSeconds: 1.4 });
    const take = makeVocalLike({ seed: 7, sampleRate: RATE, seconds: SECONDS, leadSeconds: 0.2 });
    expect(alignTakeToReference(reference, RATE, take, RATE)!.refined).toBe(true);
  });

  it('returns null when either side has no onset at all', () => {
    const reference = makeVocalLike({ seed: 5, sampleRate: RATE, seconds: SECONDS });
    expect(alignTakeToReference(reference, RATE, [new Float32Array(RATE * 5)], RATE)).toBeNull();
    expect(alignTakeToReference([new Float32Array(RATE * 5)], RATE, reference, RATE)).toBeNull();
  });

  /**
   * CP1 fix-round (I11). This test used to hand in a 0.8 s fixture, which the
   * schedule generator fills with ZERO syllables — so it was digital silence
   * and returned null through the no-onset path, never reaching the overlap
   * gate at all. The gate was covered by nothing.
   *
   * The fixture below is short but genuinely SOUNDING: syllables are forced into
   * it, so `alignmentOdf` returns a real envelope for both sides and the null
   * can only come from the gate.
   */
  it('returns null when the two are too short to overlap by the stated minimum', () => {
    const reference = makeVocalLike({ seed: 5, sampleRate: RATE, seconds: SECONDS });
    const shortSeconds = ALIGN_MIN_OVERLAP_SECONDS * 0.4;
    const stub = makeVocalLike({ seed: 5, sampleRate: RATE, seconds: shortSeconds, minSyllables: 3 });

    // The precondition that makes this a test of the GATE: both sides have an
    // onset envelope, so the no-onset arm is not what returns null.
    expect(alignmentOdf(stub, RATE)).not.toBeNull();
    expect(alignmentOdf(reference, RATE)).not.toBeNull();
    // …and the stub really is shorter than the gate demands.
    expect(shortSeconds).toBeLessThan(ALIGN_MIN_OVERLAP_SECONDS);

    expect(alignTakeToReference(reference, RATE, stub, RATE)).toBeNull();
    // Symmetric: the gate is on the SHORTER of the two, whichever side it is.
    expect(alignTakeToReference(stub, RATE, reference, RATE)).toBeNull();
  });

  /**
   * CP1 fix-round: the FRACTION half of the gate, which the floor never reaches.
   *
   * Two 20 s recordings give 4000 frames each, so the fraction (20 % = 800
   * frames = 4 s) is four times the 2 s floor and is what actually excludes the
   * far lags. Here the ONLY thing the two share is 3 s of audio — the take
   * carries a copy of the reference's opening in its last 3 s, so the true
   * offset is −17 s and its overlap is 600 frames, below the gate.
   *
   * The honest outcome is a refusal, and pinning it is pinning a real limit:
   * this gate REFUSES a genuine alignment when the two barely overlap, because a
   * Pearson denominator over a few hundred frames returns ±1 for any two signals
   * at all and a confident wrong answer is worse than none.
   */
  it('refuses a genuine alignment whose overlap is below the FRACTION gate', () => {
    const seconds = 20;
    const shared = 3;
    const reference = makeVocalLike({ seed: 61, sampleRate: RATE, seconds });
    const take = new Float32Array(seconds * RATE);
    take.set(reference[0].subarray(0, shared * RATE), (seconds - shared) * RATE);

    // The premise: both sides have onsets, so this is the gate rather than the
    // no-onset path.
    expect(alignmentOdf([take], RATE)).not.toBeNull();
    // …and the overlap at the true lag really is under the fraction.
    const overlapFrames = shared * ALIGN_FRAME_RATE_HZ;
    const gateFrames = seconds * ALIGN_FRAME_RATE_HZ * ALIGN_MIN_OVERLAP_FRACTION;
    expect(overlapFrames).toBeLessThan(gateFrames);

    const result = alignTakeToReference(reference, RATE, [take], RATE);
    const foundTheTruth =
      result !== null && result.confident && Math.abs(result.offsetSeconds + 17) < 0.05;
    expect(foundTheTruth).toBe(false);
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
    expect(bestUnrelatedPeak).toBeLessThan(worstRelatedPeak);

    // CP1 fix-round (M4): MARGIN, not mere membership. Bare `<`/`>` said only
    // that the floor was somewhere in the gap, so a change that left it 0.0001
    // above the unrelated population would pass while accepting coincidences.
    // Each floor must clear BOTH edges by a stated amount.
    expect(ALIGN_MIN_PROMINENCE - bestUnrelatedProminence).toBeGreaterThanOrEqual(
      ALIGN_PROMINENCE_MARGIN
    );
    expect(worstRelatedProminence - ALIGN_MIN_PROMINENCE).toBeGreaterThanOrEqual(
      ALIGN_PROMINENCE_MARGIN
    );
    expect(ALIGN_MIN_CORRELATION - bestUnrelatedPeak).toBeGreaterThanOrEqual(
      ALIGN_CORRELATION_MARGIN
    );
    expect(worstRelatedPeak - ALIGN_MIN_CORRELATION).toBeGreaterThanOrEqual(
      ALIGN_CORRELATION_MARGIN
    );

    // The fine pass is a REFINEMENT, not a second opinion. The clamp is
    // structural (the window is what `lagSurface` is given), so asserting it
    // alone could never fail — measured, the refinement moves 3.2-6.4 ms against
    // a 200 ms clamp, 31x of slack. Both are asserted: the structural bound for
    // what it guarantees, and the MEASURED bound so the assertion has teeth.
    expect(Math.max(...relatedRefinement)).toBeLessThanOrEqual(ALIGN_REFINE_SECONDS);
    expect(Math.max(...relatedRefinement)).toBeLessThan(0.01);

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

/**
 * CP1 fix-round: the header claims a band count for the shipped analysis rate
 * and for the rates it was chosen over. That claim is `onsetEnvelope`'s, not
 * this module's, so it is READ from `computeBandTable` rather than asserted
 * from memory — a superlative no test can reach is exactly how "every band
 * resolved" came to be written about a table that drops one.
 */
describe('the analysis rate\'s band table', () => {
  it('resolves more bands than the rates it was chosen over', () => {
    const shipped = computeBandTable(ALIGN_ANALYSIS_RATE_HZ).lo.length;
    const fullRate = computeBandTable(44100).lo.length;
    const decimated = computeBandTable(11025).lo.length;
    // eslint-disable-next-line no-console
    console.log(`bands: 11025=${decimated} 22050=${shipped} 44100=${fullRate} (BANDS=${BANDS})`);
    expect(shipped).toBeGreaterThan(fullRate);
    expect(shipped).toBeLessThanOrEqual(BANDS);
  });
});

describe('the published constants', () => {
  it('states a guard wide enough to skip the peak\'s own shoulders', () => {
    expect(ALIGN_GUARD_SECONDS).toBeGreaterThan(0.2);
    expect(ALIGN_MIN_OVERLAP_SECONDS).toBeGreaterThanOrEqual(1);
    expect(ALIGN_FRAME_RATE_HZ).toBeGreaterThanOrEqual(100);
  });
});
