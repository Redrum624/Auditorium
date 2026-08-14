import {
  ALIGN_ANALYSIS_RATE_HZ,
  ALIGN_COARSE_FRAME_RATE_HZ,
  ALIGN_FRAME_RATE_HZ,
  ALIGN_GUARD_SECONDS,
  ALIGN_MIN_CORRELATION,
  ALIGN_MIN_OVERLAP_FRACTION,
  ALIGN_MIN_OVERLAP_SECONDS,
  ALIGN_MIN_PROMINENCE,
  ALIGN_CANDIDATE_COUNT,
  ALIGN_CORRELATION_MARGIN,
  ALIGN_DRIFT_MARGIN,
  ALIGN_LAG_SPREAD_MARGIN,
  ALIGN_MAX_DRIFT_SPAN_SECONDS,
  ALIGN_MAX_LAG_SPREAD_SECONDS,
  ALIGN_MIX_REFINE_MARGIN,
  ALIGN_MIX_REFINE_SECONDS,
  ALIGN_PIECEWISE_MIN_WINDOWS,
  ALIGN_PIECEWISE_WINDOW_SECONDS,
  ALIGN_PROMINENCE_MARGIN,
  ALIGN_REFINE_SECONDS,
  ALIGN_SMOOTHING_MS,
  ALIGN_WEAK_CORRELATION,
  ALIGN_WEAK_CORRELATION_MARGIN,
  alignEnvelopes,
  alignmentOdf,
  alignTakeToReference,
  type AlignmentEnvelopes,
  type AlignmentMeasurement,
} from './coverAlign';
import { BANDS, computeBandTable } from './tempoCore';
import {
  makeVocalLike,
  mulberry32,
  perturbSchedule,
  smearAttacks,
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
    // CC2: and the outcome says WHICH refusal this is. 'unrelated' is the one
    // that means "no usable guess" — the three other answers are all offers.
    expect(result!.outcome).toBe('unrelated');
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

    // CC2 (ALIGN-6). The refusal now SAYS that the search was partial. Before,
    // the stage quoted "the best alignment found was X" while a fifth of the
    // timeline had never been evaluated — an implied search that did not happen,
    // and the exact case this fixture is built to produce.
    expect(result!.lagsTotal).toBeGreaterThan(result!.lagsEvaluated);
    expect(result!.unevaluatedLagSeconds).toBeGreaterThan(1);
    expect(result!.unevaluatedLagSeconds).toBeCloseTo(
      (result!.lagsTotal - result!.lagsEvaluated) / ALIGN_FRAME_RATE_HZ,
      9
    );
  });

  /**
   * CC2. The contract a caller compiles against: `confident` is exactly
   * `outcome === 'confident'`, and the candidate list always leads with the
   * answer the measurement reports. Both are the kind of invariant that is true
   * when written and quietly false three refactors later.
   */
  it('keeps the boolean and the candidate list consistent with the outcome', () => {
    const reference = makeVocalLike({ seed: 7, sampleRate: RATE, seconds: SECONDS, leadSeconds: 1.4 });
    const take = makeVocalLike({ seed: 7, sampleRate: RATE, seconds: SECONDS, leadSeconds: 0.2 });
    const stranger = makeVocalLike({ seed: 640, sampleRate: RATE, seconds: SECONDS, leadSeconds: 0.2 });
    // A song whose section repeats — the outcome that exists to BE a choice.
    const period = 6;
    const chorus = (leadSeconds: number, jitterSeed: number) =>
      makeVocalLike({
        seed: 55,
        sampleRate: RATE,
        seconds: period * 3,
        leadSeconds,
        repeatPeriodSeconds: period,
        timingJitterSeconds: 0.02,
        timingSeed: jitterSeed,
      });

    const results = [
      alignTakeToReference(reference, RATE, take, RATE)!,
      alignTakeToReference(reference, RATE, stranger, RATE)!,
      alignTakeToReference(chorus(0.9, 1), RATE, chorus(0.3, 2), RATE)!,
    ];
    // The three arms this test is worth running over, so none of the assertions
    // below is reached only for one kind of answer.
    expect(results.map((r) => r.outcome)).toEqual(['confident', 'unrelated', 'ambiguous']);

    for (const r of results) {
      expect(r.confident).toBe(r.outcome === 'confident');

      // CC2 fix-round (IMP-4): presence is OUTCOME-CORRELATED. Candidates ride
      // the two outcomes that are offers and nothing else, so a consumer that
      // feature-detects on the field cannot be handed three guesses by a result
      // that means "no usable guess".
      const offers = r.outcome === 'ambiguous' || r.outcome === 'weak';
      expect(r.candidates !== undefined).toBe(offers);
      if (!offers) continue;

      expect(r.candidates!.length).toBeGreaterThan(1);
      expect(r.candidates!.length).toBeLessThanOrEqual(ALIGN_CANDIDATE_COUNT);
      expect(r.candidates![0].offsetSeconds).toBe(r.offsetSeconds);
      expect(r.candidates![0].correlation).toBeCloseTo(r.peakCorrelation, 12);
      expect(r.candidates![0].prominence).toBeCloseTo(r.prominence, 12);

      // CC2 fix-round (IMP-2): the guard separation, asserted at the FULL guard
      // and on the REFINED offsets the caller will actually place. The previous
      // bound was `ALIGN_GUARD_SECONDS − 2 × ALIGN_REFINE_SECONDS` = −0.05
      // against an absolute value — a comparison that could not fail, standing
      // where the contract's one structural promise about this list was
      // supposed to be.
      for (let i = 1; i < r.candidates!.length; i++) {
        expect(r.candidates![i].correlation).toBeLessThanOrEqual(r.candidates![i - 1].correlation);
        for (let j = 0; j < i; j++) {
          expect(
            Math.abs(r.candidates![i].offsetSeconds - r.candidates![j].offsetSeconds)
          ).toBeGreaterThanOrEqual(ALIGN_GUARD_SECONDS);
        }
      }
    }
  });

  /**
   * CC2 fix-round (IMP-2). The separation above is enforced after refinement
   * rather than inherited from the coarse walk, and this is the case that proves
   * the enforcement is load-bearing rather than decorative: the fine pass may
   * move each candidate by up to ±ALIGN_REFINE_SECONDS (0.2 s) while the coarse
   * walk only guarantees ALIGN_GUARD_SECONDS (0.35 s) between them, so two
   * candidates CAN be brought within a guard of each other by refinement alone.
   */
  it('cannot emit two candidates the fine pass has moved together', () => {
    expect(2 * ALIGN_REFINE_SECONDS).toBeGreaterThan(ALIGN_GUARD_SECONDS);
    const period = 6;
    const chorus = (leadSeconds: number, jitterSeed: number) =>
      makeVocalLike({
        seed: 91,
        sampleRate: RATE,
        seconds: period * 3,
        leadSeconds,
        repeatPeriodSeconds: period,
        timingJitterSeconds: 0.02,
        timingSeed: jitterSeed,
      });
    const r = alignTakeToReference(chorus(0.9, 5), RATE, chorus(0.3, 6), RATE)!;
    expect(r.candidates).toBeDefined();
    const offsets = r.candidates!.map((c) => c.offsetSeconds);
    for (let i = 0; i < offsets.length; i++) {
      for (let j = i + 1; j < offsets.length; j++) {
        expect(Math.abs(offsets[i] - offsets[j])).toBeGreaterThanOrEqual(ALIGN_GUARD_SECONDS);
      }
    }
    // …and the list is not empty of alternatives merely because the filter ran.
    expect(offsets.length).toBeGreaterThan(1);
  });

  /**
   * CC2 fix-round (IMP-3). The gap zone: a peak above every unrelated pair the
   * sweep can build, below the acceptance floor, on a take too short for the
   * piecewise arm to have an opinion. Before the weak floor existed this was
   * `'unrelated'` — "no usable guess" — about a measurement the populations say
   * IS distinguishable from unrelated audio.
   */
  it('offers a gap-zone peak as a guess when no second arm can contradict it', () => {
    // Constructed by degrading a genuine pair until its peak lands between the
    // two floors: the same schedule, but the take is buried in noise. Searched
    // rather than asserted blind, so this test measures the zone instead of
    // hoping a magic number sits in it.
    const seconds = 6;
    const reference = makeVocalLike({ seed: 7, sampleRate: RATE, seconds, leadSeconds: 1.4 });
    let found: ReturnType<typeof alignTakeToReference> = null;
    for (const noiseAmplitude of [0.06, 0.075, 0.09, 0.11, 0.13, 0.16, 0.2]) {
      const take = makeVocalLike({
        seed: 7,
        sampleRate: RATE,
        seconds,
        leadSeconds: 0.2,
        noiseAmplitude,
        varianceSeed: 4242,
        timingJitterSeconds: 0.04,
        timingSeed: 99,
      });
      const r = alignTakeToReference(reference, RATE, take, RATE);
      if (
        r &&
        r.peakCorrelation >= ALIGN_WEAK_CORRELATION &&
        r.peakCorrelation < ALIGN_MIN_CORRELATION
      ) {
        found = r;
        break;
      }
    }
    expect(found).not.toBeNull();
    // The premise: the piecewise arm genuinely has nothing to say here.
    expect(found!.windowsMeasured).toBe(0);
    expect(found!.outcome).toBe('weak');
    expect(found!.confident).toBe(false);
    // A guess, offered with its alternatives — not a refusal.
    expect(found!.candidates).toBeDefined();
    expect(found!.candidates![0].offsetSeconds).toBe(found!.offsetSeconds);
    // …and it is a guess worth offering: the true answer is 1.2 s.
    expect(Math.abs(found!.offsetSeconds - 1.2)).toBeLessThan(0.05);
  });

  /**
   * H1 (CC2 fix-round-2 re-review, New-5). The OTHER half of the gap-zone rule,
   * which had no fixture: the same band of peaks, the opposite verdict, because
   * the second arm is not silent this time. `aboveUnrelatedBand` requires
   * `piecewise === null` — windows that ran and DISAGREED are evidence against,
   * and they outrank a peak that merely clears the unrelated population.
   *
   * Every pair the derivation sweep builds peaks either below 0.692 or above
   * 0.731 when its windows disagree, which is why the branch went unmeasured:
   * the usual way to make windows scatter — per-syllable timing jitter heavy
   * enough to break them apart — destroys the global peak on the way. This
   * construction separates the two. A song whose section REPEATS gives windows
   * that lock onto different repeats (spread in whole sections) while the
   * global peak stays high, and noise on the take then walks that peak DOWN
   * into the zone. Searched rather than asserted blind, for the same reason the
   * test above searches: the zone is 39 thousandths wide.
   */
  it('refuses a gap-zone peak when the windows ran and disagreed', () => {
    const period = 6;
    const chorus = (leadSeconds: number, jitterSeed: number, noiseAmplitude: number) =>
      makeVocalLike({
        seed: 55,
        sampleRate: RATE,
        seconds: period * 4, // long enough for the piecewise arm to speak
        leadSeconds,
        repeatPeriodSeconds: period,
        timingJitterSeconds: 0.02,
        timingSeed: jitterSeed,
        noiseAmplitude,
        varianceSeed: 4242,
      });
    const reference = chorus(0.9, 1, 0);
    let found: ReturnType<typeof alignTakeToReference> = null;
    for (const noiseAmplitude of [0.07, 0.1, 0.13, 0.16, 0.2]) {
      const r = alignTakeToReference(reference, RATE, chorus(0.3, 2, noiseAmplitude), RATE);
      if (
        r &&
        r.peakCorrelation >= ALIGN_WEAK_CORRELATION &&
        r.peakCorrelation < ALIGN_MIN_CORRELATION &&
        r.windowsMeasured > 0
      ) {
        found = r;
        break;
      }
    }
    expect(found).not.toBeNull();
    // The premise, both halves: the peak is in the gap zone, and the windows
    // ran and did NOT agree.
    expect(found!.peakCorrelation).toBeGreaterThanOrEqual(ALIGN_WEAK_CORRELATION);
    expect(found!.peakCorrelation).toBeLessThan(ALIGN_MIN_CORRELATION);
    expect(found!.windowLagSpreadSeconds).toBeGreaterThan(ALIGN_MAX_LAG_SPREAD_SECONDS);
    // …so the verdict is the one that means "no usable guess", not the 'weak'
    // the silent-second-arm case above gets from the same band of peaks.
    expect(found!.outcome).toBe('unrelated');
    expect(found!.confident).toBe(false);
    // And the contract holds on it: 'unrelated' lists no candidates, and a
    // slope through windows that scattered is not reported as a drift.
    expect(found!.candidates).toBeUndefined();
    expect(found!.driftSecondsPerMinute).toBeUndefined();
    expect(found!.driftSpanSeconds).toBeUndefined();
  });

  /**
   * CC2. The piecewise arm can only ever REFUSE confidence, never grant it — so
   * a pair too short to cut into windows must fall back to the two floors rather
   * than be refused for silence. The shipped e2e fixture pair lands exactly
   * here (5.25 s of overlap), so this is not a hypothetical.
   */
  it('still places a take too short for the piecewise arm to speak about', () => {
    const seconds = 6;
    const reference = makeVocalLike({ seed: 7, sampleRate: RATE, seconds, leadSeconds: 1.4 });
    const take = makeVocalLike({ seed: 7, sampleRate: RATE, seconds, leadSeconds: 0.2 });
    const r = alignTakeToReference(reference, RATE, take, RATE)!;
    expect(r.overlapSeconds).toBeLessThan(
      ALIGN_PIECEWISE_MIN_WINDOWS * ALIGN_PIECEWISE_WINDOW_SECONDS
    );
    expect(r.windowsMeasured).toBe(0);
    expect(r.windowLagSpreadSeconds).toBeUndefined();
    expect(r.driftSecondsPerMinute).toBeUndefined();
    expect(r.driftSpanSeconds).toBeUndefined();
    expect(r.outcome).toBe('confident');
    expect(Math.abs(r.offsetSeconds - 1.2)).toBeLessThan(TOLERANCE_SECONDS);
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
  /** CC2. The human-timing half of the cover population. Fewer seeds than the
   * rigid half on purpose: the pairs are the expensive part of this file and six
   * sufficed to reproduce the regime in the investigation that found it. */
  const JITTER_SEEDS = 8;
  /** CC2. The drift and repeated-section rows are twice and nearly three times
   * the audio per pair, so they carry the fewest seeds that still show a
   * population rather than an anecdote. */
  const DRIFT_SEEDS = 4;
  const REPEAT_SEEDS = 4;
  const SWEEP_SECONDS = 10;
  const SWEEP_OFFSET = 0.6;
  /**
   * CC2. The per-syllable timing variance the shipped floors never saw. ±40 ms
   * (uniform, SD 23 ms) is the band where the un-smoothed evidence collapses to
   * 0.43–0.57 peak — below the 0.607 floor — WHILE the recovered offset stays
   * correct to 29 ms. It is pinned as the calibration regime because it is the
   * one that refused a real user's real cover.
   */
  const HUMAN_JITTER_SECONDS = 0.04;

  /** The pairs' ENVELOPES, computed once. Framing 20 s of audio per pair is the
   * whole cost of this file; every sweep below re-correlates those envelopes
   * rather than re-rendering the audio, which is what makes a smoothing-width
   * sweep affordable at all. */
  const envelopeCache = new Map<string, { a: AlignmentEnvelopes; b: AlignmentEnvelopes }>();
  // The cache is what makes a smoothing-width sweep affordable, and it is also
  // the largest thing this file holds; dropping it at the end lets the worker
  // exit with its hands empty rather than at its high-water mark.
  afterAll(() => envelopeCache.clear());

  interface PairOptions {
    timingJitterSeconds?: number;
    tempoScale?: number;
    seconds?: number;
    repeatPeriodSeconds?: number;
  }

  function sweepPair(
    referenceSeed: number,
    takeSeed: number,
    varianceSeed: number,
    opts: PairOptions = {}
  ): { a: AlignmentEnvelopes; b: AlignmentEnvelopes } {
    const {
      timingJitterSeconds = 0,
      tempoScale = 1,
      seconds = SWEEP_SECONDS,
      repeatPeriodSeconds = 0,
    } = opts;
    const key = `${referenceSeed}/${takeSeed}/${varianceSeed}/${timingJitterSeconds}/${tempoScale}/${seconds}/${repeatPeriodSeconds}`;
    const hit = envelopeCache.get(key);
    if (hit) return hit;
    const reference = makeVocalLike({
      seed: referenceSeed,
      sampleRate: 44100,
      seconds,
      leadSeconds: 0.9,
      repeatPeriodSeconds,
    });
    const take = makeVocalLike({
      seed: takeSeed,
      sampleRate: 48000,
      seconds,
      leadSeconds: 0.3,
      hzScale: 1.26,
      amplitudeJitter: 0.5,
      noiseAmplitude: 0.012,
      varianceSeed,
      repeatPeriodSeconds,
      tempoScale,
      timingJitterSeconds,
      timingSeed: varianceSeed * 3 + 17,
    });
    const a = alignmentOdf(reference, 44100);
    const b = alignmentOdf(take, 48000);
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    const built = { a: a!, b: b! };
    envelopeCache.set(key, built);
    return built;
  }

  /** Same schedule, different performance, onsets shared TO THE SAMPLE — the
   * population the shipped floors were derived from, kept so this change can be
   * shown not to have cost the easy case anything. */
  const rigidCover = (seed: number) => sweepPair(seed, seed, seed * 7 + 3);
  /** …and the same, sung by a human being: every syllable early or late by its
   * own draw. */
  const humanCover = (seed: number) =>
    sweepPair(seed, seed, seed * 7 + 3, { timingJitterSeconds: HUMAN_JITTER_SECONDS });
  /** A schedule with nothing to do with the reference's. */
  const unrelated = (seed: number) => sweepPair(seed, seed + 7919, seed * 13 + 5);

  /** CC2. The DRIFT populations, and the control they are measured against.
   * Twenty seconds rather than ten because a drift is a quantity per unit time
   * and a ten-second window is too short for a slope to rise out of the noise —
   * measuring the control at the same length is what makes the comparison
   * like-for-like rather than a comparison with zero. */
  const DRIFT_SECONDS = 20;
  const drifting = (seed: number, tempoScale: number) =>
    sweepPair(seed, seed, seed * 7 + 3, {
      tempoScale,
      seconds: DRIFT_SECONDS,
      timingJitterSeconds: 0.02,
    });
  /** CC2. A song whose section repeats — where the rival lag is a GENUINE
   * partial match rather than a coincidence, and where prominence therefore has
   * to mean "several places" rather than "no relation". */
  /**
   * CC2. The length at which the piecewise arm can be derived AGAINST unrelated
   * audio at all — and the reason it is not ten seconds like everything else.
   *
   * The min-overlap gate is 20 % of the shorter recording, and an unrelated
   * pair's winning lag lands at that gate: a Pearson denominator over few frames
   * flatters any two signals, so the surface's maximum for audio with no
   * relation sits where the overlap is smallest. Twenty per cent of a ten-second
   * fixture is two seconds, which cannot be cut into
   * ALIGN_PIECEWISE_MIN_WINDOWS × ALIGN_PIECEWISE_WINDOW_SECONDS — measured, ZERO
   * of the sixteen unrelated ten-second pairs produce piecewise evidence at all.
   *
   * That is not a hole in the arm; it is the arm declining to speak, and the
   * verdict treats silence as "carries no weight". But a ceiling cannot be
   * derived against a population that never appears, so the derivation uses the
   * shortest length where BOTH classes speak: 20 % of 45 s is 9 s, exactly three
   * windows. Real songs are minutes long and live here, not at ten seconds.
   */
  const PIECEWISE_SECONDS = 45;
  const PIECEWISE_SEEDS = 3;
  const longCover = (seed: number) =>
    sweepPair(seed, seed, seed * 7 + 3, {
      seconds: PIECEWISE_SECONDS,
      timingJitterSeconds: HUMAN_JITTER_SECONDS,
    });
  const longUnrelated = (seed: number) =>
    sweepPair(seed, seed + 7919, seed * 13 + 5, { seconds: PIECEWISE_SECONDS });

  const REPEAT_PERIOD_SECONDS = 6;
  const repeated = (seed: number) =>
    sweepPair(seed, seed, seed * 7 + 3, {
      seconds: REPEAT_PERIOD_SECONDS * 3,
      repeatPeriodSeconds: REPEAT_PERIOD_SECONDS,
      timingJitterSeconds: 0.02,
    });

  // ── CC2 fix-round (IMP-1): the adversarial half of "unrelated" ─────────────
  //
  // Seed-diverse aperiodic schedules were the WHOLE unrelated population, and
  // three things happened to the safety side at once: the correlation margin
  // over unrelated audio halved, smoothing lifted the unrelated ceiling by 0.21,
  // and prominence retired as a second independent barrier. A population that
  // did not grow to match that is a margin measured against the easy case.
  //
  // These are the shapes the journey actually feeds the aligner, not shapes
  // chosen to be beatable.

  /** Envelopes for an arbitrary pair of signals, cached like `sweepPair`'s. */
  function envelopePair(
    key: string,
    build: () => { reference: Float32Array[]; referenceRate: number; take: Float32Array[]; takeRate: number }
  ): { a: AlignmentEnvelopes; b: AlignmentEnvelopes } {
    const hit = envelopeCache.get(key);
    if (hit) return hit;
    const { reference, referenceRate, take, takeRate } = build();
    const a = alignmentOdf(reference, referenceRate);
    const b = alignmentOdf(take, takeRate);
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    const built = { a: a!, b: b! };
    envelopeCache.set(key, built);
    return built;
  }

  /** Broadband noise at a peak amplitude — a room, a preamp, a stem the model
   * emptied. NOT digital silence: silence returns `null` through the no-onset
   * path and never reaches a threshold, which is precisely why it proves
   * nothing about one. */
  const roomTone = (seed: number, seconds: number, rate: number, amplitude: number) => {
    const rng = mulberry32(seed);
    const n = new Float32Array(Math.round(seconds * rate));
    for (let i = 0; i < n.length; i++) n[i] = amplitude * (rng() * 2 - 1);
    return [n];
  };

  /**
   * (a) LEAKAGE. The journey's reference is a SEPARATED vocal stem, and this
   * repo has already measured what the real model does to a synthetic mix:
   * routed the voice almost entirely to Other and returned Vocals 41 dB down and
   * empty (`e2e-smoke.cjs`, finding CJ-3). What is left in that stem is the
   * song's ACCOMPANIMENT — a different rhythm from the vocal line — under a
   * noise floor. The ODF is std-normalised, so being 40 dB down does not make
   * those onsets weak; it makes them the ONLY onsets, at full strength.
   */
  const leakagePair = (seed: number) =>
    envelopePair(`leak/${seed}`, () => {
      const accompaniment = makeVocalLike({
        // A different schedule: the band is not singing the vocal line.
        seed: seed * 31 + 7,
        sampleRate: 44100,
        seconds: SWEEP_SECONDS,
        leadSeconds: 0.9,
      });
      const gain = Math.pow(10, -40 / 20);
      const floor = roomTone(seed * 5 + 1, SWEEP_SECONDS + 0.9, 44100, 0.0008)[0];
      const stem = Float32Array.from(accompaniment[0], (v, i) => v * gain + (floor[i] ?? 0));
      return {
        reference: [stem],
        referenceRate: 44100,
        take: makeVocalLike({
          seed,
          sampleRate: 48000,
          seconds: SWEEP_SECONDS,
          leadSeconds: 0.3,
          hzScale: 1.26,
          amplitudeJitter: 0.5,
          noiseAmplitude: 0.012,
          varianceSeed: seed * 7 + 3,
          timingJitterSeconds: HUMAN_JITTER_SECONDS,
          timingSeed: seed * 3 + 17,
        }),
        takeRate: 48000,
      };
    });

  /** (b) ROOM TONE, both ways round: a stem with nothing in it against a real
   * take, and a real stem against a take where the singer never came in. */
  const roomToneReference = (seed: number) =>
    envelopePair(`tone-ref/${seed}`, () => ({
      reference: roomTone(seed, SWEEP_SECONDS + 0.9, 44100, 0.02),
      referenceRate: 44100,
      take: makeVocalLike({
        seed,
        sampleRate: 48000,
        seconds: SWEEP_SECONDS,
        leadSeconds: 0.3,
        hzScale: 1.26,
        amplitudeJitter: 0.5,
        noiseAmplitude: 0.012,
        varianceSeed: seed * 7 + 3,
      }),
      takeRate: 48000,
    }));
  const roomToneTake = (seed: number) =>
    envelopePair(`tone-take/${seed}`, () => ({
      reference: makeVocalLike({
        seed,
        sampleRate: 44100,
        seconds: SWEEP_SECONDS,
        leadSeconds: 0.9,
      }),
      referenceRate: 44100,
      take: roomTone(seed * 11 + 3, SWEEP_SECONDS + 0.3, 48000, 0.02),
      takeRate: 48000,
    }));

  /**
   * (c) PERIODIC, SAME TEMPO. The shape smoothing favours most, and the one the
   * guard interacts with: at this period the beat sits INSIDE
   * ALIGN_GUARD_SECONDS, so the nearest beat-phase rival is excluded from the
   * rival search by construction. Two recordings with no relation beyond a
   * shared tempo — which is not a relation at all.
   */
  const METRONOME_PERIOD_SECONDS = 0.34;
  const metronomicUnrelated = (seed: number) =>
    envelopePair(`metro/${seed}`, () => ({
      reference: makeVocalLike({
        seed,
        sampleRate: 44100,
        seconds: SWEEP_SECONDS,
        leadSeconds: 0.9,
        repeatPeriodSeconds: METRONOME_PERIOD_SECONDS,
        minSyllables: 1,
      }),
      referenceRate: 44100,
      take: makeVocalLike({
        seed: seed + 7919,
        sampleRate: 48000,
        seconds: SWEEP_SECONDS,
        leadSeconds: 0.3,
        repeatPeriodSeconds: METRONOME_PERIOD_SECONDS,
        minSyllables: 1,
        hzScale: 1.26,
        amplitudeJitter: 0.5,
        noiseAmplitude: 0.012,
        varianceSeed: seed * 13 + 5,
      }),
      takeRate: 48000,
    }));

  const ADVERSARIAL_SEEDS = 4;
  const adversarialTier1 = (smoothingMs: number) =>
    Array.from({ length: ADVERSARIAL_SEEDS }, (_, s) => [
      alignEnvelopes(leakagePair(8000 + s), smoothingMs)!,
      alignEnvelopes(roomToneReference(8100 + s), smoothingMs)!,
      alignEnvelopes(roomToneTake(8200 + s), smoothingMs)!,
    ]).flat();
  const adversarialPeriodic = (smoothingMs: number) =>
    Array.from(
      { length: ADVERSARIAL_SEEDS },
      (_, s) => alignEnvelopes(metronomicUnrelated(8300 + s), smoothingMs)!
    );

  const span = (v: number[]) => ({
    min: Number(Math.min(...v).toFixed(4)),
    max: Number(Math.max(...v).toFixed(4)),
  });

  interface Population {
    cover: AlignmentMeasurement[];
    /** TIER 1: everything a CORRELATION floor has to sit above. */
    unrelated: AlignmentMeasurement[];
    /** TIER 2: unrelated audio that a correlation floor CANNOT catch and does
     * not have to — two metronomes at one tempo genuinely do match at many
     * lags, so the prominence arm answers them with `'ambiguous'`. Kept out of
     * the floor derivation for the same reason the repeated-section population
     * is, and asserted separately to never reach `'confident'`. */
    periodic: AlignmentMeasurement[];
  }

  /** Every pair measured at one smoothing width. */
  function populationsAt(smoothingMs: number): Population {
    const cover: AlignmentMeasurement[] = [];
    const unrel: AlignmentMeasurement[] = [];
    for (let s = 0; s < SEEDS; s++) {
      const r = alignEnvelopes(rigidCover(1000 + s), smoothingMs);
      const u = alignEnvelopes(unrelated(2000 + s), smoothingMs);
      expect(r).not.toBeNull();
      expect(u).not.toBeNull();
      cover.push(r!);
      unrel.push(u!);
    }
    for (let s = 0; s < JITTER_SEEDS; s++) {
      const h = alignEnvelopes(humanCover(3000 + s), smoothingMs);
      expect(h).not.toBeNull();
      cover.push(h!);
    }
    unrel.push(...adversarialTier1(smoothingMs));
    return { cover, unrelated: unrel, periodic: adversarialPeriodic(smoothingMs) };
  }

  /** The gap the CORRELATION floor has to live in — the arm that now carries
   * relatedness, and the arm the smoothing width exists to widen. */
  function separation(p: Population): number {
    return (
      Math.min(...p.cover.map((m) => m.peakCorrelation)) -
      Math.max(...p.unrelated.map((m) => m.peakCorrelation))
    );
  }

  /**
   * CC2. WHERE THE SMOOTHING WIDTH COMES FROM.
   *
   * The evidence is one Pearson pass over two onset envelopes, and an onset
   * envelope is near-zero everywhere except at an attack. When the take's
   * attacks sit ±40 ms from the reference's, the two lobes barely touch at ANY
   * lag and the correlation collapses — which is what refused a real cover whose
   * offset was right. Low-passing both envelopes widens each lobe so it spans
   * that variance; too wide and the surface turns into two slow curves that
   * correlate whatever they are, and the gap closes again from the other side.
   *
   * So the width is swept, not chosen. A band-pass (subtracting a wider local
   * mean, on the theory that the slow "someone is singing" shape is what lifts
   * the unrelated population) was swept too and LOST at every width — recorded
   * here because it is the obvious next idea and it does not work.
   *
   * The assertion is that the shipped width sits in the FLAT TOP of the measured
   * maximum, not that it is the exact argmax: neighbouring widths differ by
   * ~0.005 of gap, which is smaller than the difference any of them makes to a
   * decision, and pinning the argmax would claim a precision the surface does
   * not have.
   */
  it('derives the smoothing width from the populations it has to separate', () => {
    const candidates = [0, 80, 120, 160, 200, 240, 280];
    const rows = candidates.map((ms) => ({ ms, gap: separation(populationsAt(ms)) }));
    // eslint-disable-next-line no-console
    console.log(
      ['smoothing ms  correlation gap']
        .concat(rows.map((r) => `${String(r.ms).padStart(9)}  ${r.gap.toFixed(4).padStart(9)}`))
        .join('\n  ')
    );
    const best = rows.reduce((a, b) => (b.gap > a.gap ? b : a));
    const shipped = rows.find((r) => r.ms === ALIGN_SMOOTHING_MS);
    expect(shipped).toBeDefined();
    expect(best.gap - shipped!.gap).toBeLessThanOrEqual(0.01);
    // The maximum is INTERIOR — the sweep found a peak rather than running out
    // of candidates at an edge, which is the difference between a measurement
    // and a direction.
    expect(best.ms).toBeGreaterThan(candidates[0]);
    expect(best.ms).toBeLessThan(candidates[candidates.length - 1]);
    // …and the win over doing nothing is the reason this exists at all. Stated
    // as a number so a future change that makes smoothing pointless fails here.
    const none = rows.find((r) => r.ms === 0)!;
    expect(shipped!.gap - none.gap).toBeGreaterThan(0.15);
  });

  it('separates covers from unrelated audio, and both thresholds sit in the gap', () => {
    const p = populationsAt(ALIGN_SMOOTHING_MS);
    const relatedProminence = p.cover.map((m) => m.prominence);
    const relatedPeak = p.cover.map((m) => m.peakCorrelation);
    const relatedError = p.cover.map((m) => Math.abs(m.offsetSeconds - SWEEP_OFFSET));
    const relatedRefinement = p.cover.map((m) => Math.abs(m.offsetSeconds - m.coarseOffsetSeconds));
    const unrelatedProminence = p.unrelated.map((m) => m.prominence);
    const unrelatedPeak = p.unrelated.map((m) => m.peakCorrelation);
    const humanError = p.cover.slice(SEEDS).map((m) => Math.abs(m.offsetSeconds - SWEEP_OFFSET));

    // The derivation, printed. `ALIGN_MIN_PROMINENCE` and
    // `ALIGN_MIN_CORRELATION` are points inside these gaps.
    // eslint-disable-next-line no-console
    console.log(
      [
        `adversarial leakage   ${JSON.stringify(span(adversarialTier1(ALIGN_SMOOTHING_MS).filter((_, i) => i % 3 === 0).map((m) => m.peakCorrelation)))}`,
        `adversarial tone ref  ${JSON.stringify(span(adversarialTier1(ALIGN_SMOOTHING_MS).filter((_, i) => i % 3 === 1).map((m) => m.peakCorrelation)))}`,
        `adversarial tone take ${JSON.stringify(span(adversarialTier1(ALIGN_SMOOTHING_MS).filter((_, i) => i % 3 === 2).map((m) => m.peakCorrelation)))}`,
        `periodic peak/prom    ${JSON.stringify(span(p.periodic.map((m) => m.peakCorrelation)))} / ${JSON.stringify(span(p.periodic.map((m) => m.prominence)))}`,
        `cover prominence      ${JSON.stringify(span(relatedProminence))}`,
        `unrelated prominence  ${JSON.stringify(span(unrelatedProminence))}`,
        `cover correlation     ${JSON.stringify(span(relatedPeak))}`,
        `unrelated correlation ${JSON.stringify(span(unrelatedPeak))}`,
        `cover offset error s  ${JSON.stringify(span(relatedError))}`,
        `  of which ±40 ms     ${JSON.stringify(span(humanError))}`,
        `refinement moved s    ${JSON.stringify(span(relatedRefinement))}`,
      ].join('\n  ')
    );

    const worstRelatedProminence = Math.min(...relatedProminence);
    const bestUnrelatedProminence = Math.max(...unrelatedProminence);
    const worstRelatedPeak = Math.min(...relatedPeak);
    const bestUnrelatedPeak = Math.max(...unrelatedPeak);

    // The gap itself, so a regression reads as a number rather than as a boolean
    // that flipped. CC2: only the CORRELATION gap is asserted against unrelated
    // audio now. The prominence gap against this population has not closed but
    // INVERTED at the smoothing width the correlation arm needs — measured, the
    // best unrelated pair reaches 0.2491 while the worst cover reaches 0.217,
    // so the populations overlap by 0.032 in the WRONG direction. That is stated
    // rather than papered over, and asserted twenty lines below in the direction
    // the run actually takes: prominence stopped being able to carry
    // relatedness, and the floor derived below is for the question it CAN
    // answer. Relatedness is carried by correlation and by the piecewise
    // agreement two tests down.
    expect(bestUnrelatedPeak).toBeLessThan(worstRelatedPeak);

    // CP1 fix-round (M4): MARGIN, not mere membership. Bare `<`/`>` said only
    // that the floor was somewhere in the gap, so a change that left it 0.0001
    // above the unrelated population would pass while accepting coincidences.
    // The floor must clear BOTH edges by a stated amount.
    expect(ALIGN_MIN_CORRELATION - bestUnrelatedPeak).toBeGreaterThanOrEqual(
      ALIGN_CORRELATION_MARGIN
    );
    expect(worstRelatedPeak - ALIGN_MIN_CORRELATION).toBeGreaterThanOrEqual(
      ALIGN_CORRELATION_MARGIN
    );
    // The prominence floor still has to sit under every aperiodic cover, or a
    // real cover would be reported as matching several places when it matches
    // one. Its other edge is derived against the repeated-section population.
    expect(worstRelatedProminence - ALIGN_MIN_PROMINENCE).toBeGreaterThanOrEqual(
      ALIGN_PROMINENCE_MARGIN
    );
    // CC2 fix-round (IMP-5): and the direction of the prominence relationship is
    // asserted rather than described. Against the ENLARGED unrelated population
    // it does not merely fail to separate — it INVERTS: the best unrelated pair
    // out-prominences the worst cover. Pinning that keeps the docblock honest,
    // and a future change that restored a positive gap would fail here and force
    // someone to re-read why this floor stopped answering that question.
    expect(bestUnrelatedProminence).toBeGreaterThan(worstRelatedProminence);

    // CC2 fix-round (IMP-3): the WEAK floor, in the same gap, from the same two
    // edges. It exists because a peak above every unrelated pair the sweep can
    // build is evidence even when nothing else can be measured — and calling
    // that 'unrelated' was the outcome label overclaiming.
    expect(ALIGN_WEAK_CORRELATION - bestUnrelatedPeak).toBeGreaterThanOrEqual(
      ALIGN_WEAK_CORRELATION_MARGIN
    );
    expect(ALIGN_MIN_CORRELATION - ALIGN_WEAK_CORRELATION).toBeGreaterThanOrEqual(
      ALIGN_WEAK_CORRELATION_MARGIN
    );

    // The fine pass is a REFINEMENT, not a second opinion. The clamp is
    // structural (the window is what `lagSurface` is given), so asserting it
    // alone could never fail. CC2 fix-round: the measured figure is 0.4-39.4 ms,
    // not the 3.2-6.4 ms this comment claimed before the envelopes were smoothed
    // — a wider coarse lobe leaves the fine pass more to correct. Both bounds
    // are asserted: the structural one for what it guarantees, and the MEASURED
    // one (45 ms, 1.14x of the worst case) so the assertion has teeth.
    expect(Math.max(...relatedRefinement)).toBeLessThanOrEqual(ALIGN_REFINE_SECONDS);
    expect(Math.max(...relatedRefinement)).toBeLessThan(0.045);

    // The ±10 ms requirement is pinned by the ground-truth cases above, where
    // the take IS the reference at a known offset and the answer is not a
    // matter of opinion. THIS population is harder and its residual is stated
    // rather than asserted away: two different performances of one schedule
    // disagree about where a syllable starts, and a human one disagrees by the
    // ±40 ms the fixture now draws. The ceiling is on that disagreement, not a
    // restatement of the requirement — and it is BELOW the jitter itself, which
    // is the point: the aligner averages the variance out rather than following
    // any one syllable. CC2 fix-round (IMP-6): pinned at the MEASURED 28.9 ms
    // plus a little headroom rather than at the 40 ms of jitter, which was a
    // ceiling loose enough to pass without measuring anything.
    expect(Math.max(...relatedError)).toBeLessThan(0.035);
    expect(Math.max(...relatedError)).toBeLessThan(HUMAN_JITTER_SECONDS);
  });

  it('every related pair is accepted and every unrelated pair refused', () => {
    const p = populationsAt(ALIGN_SMOOTHING_MS);
    for (const m of p.cover) expect(m.outcome).toBe('confident');
    // TIER 1 — seed-diverse schedules, a leakage stem, and room tone on either
    // side: all under the correlation floor AND under the weak floor, so the
    // answer is the one that means "no usable guess".
    for (const m of p.unrelated) expect(m.outcome).toBe('unrelated');
    // TIER 2 — two recordings sharing only a tempo. A correlation floor cannot
    // catch these and does not have to: they peak at 0.95 because they genuinely
    // DO match at many lags, and the prominence arm says exactly that. The
    // property that matters is the one asserted — never `'confident'`, never
    // applied automatically — and the offer they produce is a choice of lags.
    expect(p.periodic.length).toBeGreaterThan(0);
    for (const m of p.periodic) {
      expect(m.outcome).toBe('ambiguous');
      expect(m.confident).toBe(false);
      expect(m.peakCorrelation).toBeGreaterThan(ALIGN_MIN_CORRELATION);
      expect(m.prominence).toBeLessThan(ALIGN_MIN_PROMINENCE);
      // H1 (CC2 fix-round-2 re-review, New-6): the contract puts no MINIMUM on
      // `candidates`. The post-refinement separation filter drops entries
      // without backfilling from the next coarse peak, so an offer could in
      // principle arrive with nothing to offer — "pick one below" over an empty
      // list. Asserted on every 'ambiguous' this population emits, which is the
      // population the filter is most likely to bite on: these pairs match at
      // several lags by construction.
      expect(m.candidates).toBeDefined();
      expect(m.candidates!.length).toBeGreaterThanOrEqual(1);
    }
    // The half that matters: a cover sung by a human being, refused before CC2.
    // H1 (New-7): the SIZE pin the `slice(SEEDS, SEEDS + JITTER_SEEDS)` rework
    // dropped. The slice form alone is a lower bound — it says the human half
    // is there, not that the population is only what it says it is — so a
    // member silently added or lost above would go unnoticed while every
    // outcome assertion above kept passing.
    expect(p.cover).toHaveLength(SEEDS + JITTER_SEEDS);
    expect(p.cover.slice(SEEDS, SEEDS + JITTER_SEEDS)).toHaveLength(JITTER_SEEDS);
  });

  /**
   * CC2. WHERE THE PIECEWISE CEILING COMES FROM.
   *
   * The windows are aligned INDEPENDENTLY, so unrelated audio has no lag for
   * them to agree on and they scatter; a cover holds one lag whatever its
   * timing variance, and a DRIFTING cover holds one lag to within the drift.
   * That is a far wider gap than either floor above, which is why this arm is
   * what rescues a marginal correlation instead of the other way round.
   *
   * The repeated-section population is deliberately NOT in this derivation: its
   * windows lock onto different repeats and scatter by whole sections, which is
   * a true statement about a take that genuinely matches several places rather
   * than evidence about relatedness. The verdict asks the ambiguity question
   * first for exactly that reason.
   */
  it('derives the piecewise agreement ceiling from windows that cannot agree', () => {
    const p = populationsAt(ALIGN_SMOOTHING_MS);
    const spreads = (ms: AlignmentMeasurement[]) =>
      ms.filter((m) => m.windowLagSpreadSeconds !== undefined).map((m) => m.windowLagSpreadSeconds!);
    const coverSpread = spreads(p.cover);
    const driftSpread = spreads(
      [1.002, 1.005].flatMap((ts) =>
        Array.from({ length: DRIFT_SEEDS }, (_, s) => alignEnvelopes(drifting(4000 + s, ts))!)
      )
    );
    const longCoverSpread = spreads(
      Array.from({ length: PIECEWISE_SEEDS }, (_, s) => alignEnvelopes(longCover(6000 + s))!)
    );
    const longUnrelatedRuns = Array.from(
      { length: PIECEWISE_SEEDS },
      (_, s) => alignEnvelopes(longUnrelated(7000 + s))!
    );
    const longUnrelatedSpread = spreads(longUnrelatedRuns);
    // The premise of the derivation, asserted rather than assumed: at ten
    // seconds the unrelated pairs say NOTHING, and at forty-five they all do.
    expect(coverSpread).toHaveLength(p.cover.length);
    expect(spreads(p.unrelated)).toHaveLength(0);
    expect(longUnrelatedSpread).toHaveLength(PIECEWISE_SEEDS);
    expect(longCoverSpread).toHaveLength(PIECEWISE_SEEDS);
    // eslint-disable-next-line no-console
    console.log(
      [
        `cover window spread s        ${JSON.stringify(span(coverSpread))}`,
        `drifting window spread s     ${JSON.stringify(span(driftSpread))}`,
        `45 s cover window spread s   ${JSON.stringify(span(longCoverSpread))}`,
        `45 s unrelated spread s      ${JSON.stringify(span(longUnrelatedSpread))}`,
      ].join('\n  ')
    );
    const worstRelated = Math.max(...coverSpread, ...driftSpread, ...longCoverSpread);
    const bestUnrelated = Math.min(...longUnrelatedSpread);
    expect(worstRelated).toBeLessThan(bestUnrelated);
    expect(ALIGN_MAX_LAG_SPREAD_SECONDS - worstRelated).toBeGreaterThanOrEqual(
      ALIGN_LAG_SPREAD_MARGIN
    );
    expect(bestUnrelated - ALIGN_MAX_LAG_SPREAD_SECONDS).toBeGreaterThanOrEqual(
      ALIGN_LAG_SPREAD_MARGIN
    );
  });

  /**
   * CC2. WHERE THE DRIFT CEILING COMES FROM — and what this arm cannot do.
   *
   * The slope through three to twelve window lags is the drift. It is fitted
   * through noisy points, so the honest question is not "is the slope nonzero"
   * but "is it bigger than the slope a straight line finds in a take that is NOT
   * drifting at all" — hence a control of the same length, same construction,
   * `tempoScale` 1.
   *
   * The measurement below also states the limit plainly: the mild regime the
   * investigation flagged (×1.001–1.002 over 20 s, 25–30 ms of placement error)
   * produces a slope INSIDE the control's own band on a take this short. That
   * drift is real and its cost is real, and this arm cannot resolve it here —
   * so it is reported rather than gated, and the ceiling is placed where the
   * populations actually separate.
   */
  it('derives the drift ceiling against a no-drift control of the same length', () => {
    const at = (tempoScale: number) =>
      Array.from(
        { length: DRIFT_SEEDS },
        (_, s) => alignEnvelopes(drifting(4000 + s, tempoScale))!
      );
    const spans = (ms: AlignmentMeasurement[]) =>
      ms.map((m) => {
        expect(m.driftSpanSeconds).toBeDefined();
        expect(m.driftSecondsPerMinute).toBeDefined();
        return m.driftSpanSeconds!;
      });
    const rate = (ms: AlignmentMeasurement[]) => ms.map((m) => m.driftSecondsPerMinute!);
    const error = (ms: AlignmentMeasurement[]) =>
      ms.map((m) => Math.abs(m.offsetSeconds - SWEEP_OFFSET));
    const control = at(1);
    const mild = at(1.002);
    const heavy = at(1.005);
    // The no-drift population is every construction that is NOT drifting, at
    // every length this file measures — because the noise on a slope through
    // three windows of a ten-second take is larger than through six windows of
    // a twenty-second one, and a ceiling that only ever saw the long case would
    // refuse short takes for measurement noise.
    const p = populationsAt(ALIGN_SMOOTHING_MS);
    const shortControl = spans(p.cover);
    const longControl = spans(control);
    // eslint-disable-next-line no-console
    console.log(
      [
        `drift span s  10 s covers   ${JSON.stringify(span(shortControl))}`,
        `drift span s  control x1     ${JSON.stringify(span(longControl))}  s/min ${JSON.stringify(span(rate(control)))}  offset err ${JSON.stringify(span(error(control)))}`,
        `drift span s  mild    x1.002 ${JSON.stringify(span(spans(mild)))}  s/min ${JSON.stringify(span(rate(mild)))}  offset err ${JSON.stringify(span(error(mild)))}`,
        `drift span s  heavy   x1.005 ${JSON.stringify(span(spans(heavy)))}  s/min ${JSON.stringify(span(rate(heavy)))}  offset err ${JSON.stringify(span(error(heavy)))}`,
      ].join('\n  ')
    );
    const noiseFloor = Math.max(...shortControl, ...longControl);
    const heaviest = Math.min(...spans(heavy));
    expect(noiseFloor).toBeLessThan(heaviest);
    expect(ALIGN_MAX_DRIFT_SPAN_SECONDS - noiseFloor).toBeGreaterThanOrEqual(ALIGN_DRIFT_MARGIN);
    expect(heaviest - ALIGN_MAX_DRIFT_SPAN_SECONDS).toBeGreaterThanOrEqual(ALIGN_DRIFT_MARGIN);

    // The consequence, pinned: heavy drift is no longer 'not believable'. It is
    // a usable guess with a number attached, and the number has the right SIGN —
    // a take running slow falls progressively behind.
    for (const m of heavy) {
      expect(m.outcome).toBe('weak');
      expect(m.driftSecondsPerMinute!).toBeLessThan(0);
    }
    // …and a take that is not drifting is still placed.
    for (const m of control) expect(m.outcome).toBe('confident');
    // The mild regime the investigation flagged: still confident — the gate is
    // deliberately above it, because refusing it would cost far more takes than
    // it saved — but now carrying the drift figure that EXPLAINS the placement
    // error the investigation measured, which is stated here as a ceiling rather
    // than asserted away.
    for (const m of mild) expect(m.outcome).toBe('confident');
    // CC2 fix-round (IMP-6): the measured 29.8 ms with headroom, not a 50 ms
    // ceiling 68 % above anything the sweep produces.
    expect(Math.max(...error(mild))).toBeLessThan(0.035);
    expect(Math.max(...error(mild))).toBeGreaterThan(Math.max(...error(control)));
  });

  /**
   * CC2 fix-round 2 (New-1). The drift gate, pinned in BOTH directions.
   *
   * `driftIsMeaningful = piecewise !== null && windowsAgree` was the whole
   * content of the IMP-4 fix and nothing asserted the `&& windowsAgree` half:
   * deleting that conjunct left all thirty-two tests green, which means the
   * distinction between "a slope through windows that agree" and "a slope
   * through windows that landed seconds apart" was documented and not defended.
   *
   * A slope needs the windows to have agreed before it is a drift at all. Fitted
   * through windows that scattered over four seconds of unrelated audio it is an
   * arbitrary number wearing a unit — and a caller feature-detecting on the
   * field would show it to a user as "your take slides N s per minute".
   *
   * The pair below is the gate from both sides: windows that ran and DISAGREED
   * carry no drift number, and windows that ran and AGREED on a genuinely
   * drifting take still do.
   */
  it('reports a drift only when the windows it was fitted through agreed', () => {
    // ── the arm that must be SILENT ──────────────────────────────────────────
    // 45 s unrelated pairs are the population whose windows measurably scatter
    // (0.65–7.355 s against a 0.34 s ceiling), and they are long enough that the
    // piecewise arm actually RUNS — which is what makes this a test of the
    // agreement conjunct rather than of the `piecewise === null` one.
    const disagreeing = Array.from(
      { length: PIECEWISE_SEEDS },
      (_, s) => alignEnvelopes(longUnrelated(7000 + s))!
    );
    for (const m of disagreeing) {
      // The premise: the arm SPOKE, and what it said was "these do not agree".
      expect(m.windowsMeasured).toBeGreaterThanOrEqual(ALIGN_PIECEWISE_MIN_WINDOWS);
      expect(m.windowLagSpreadSeconds).toBeDefined();
      expect(m.windowLagSpreadSeconds!).toBeGreaterThan(ALIGN_MAX_LAG_SPREAD_SECONDS);
      // …so the slope through them is not a drift, and is not reported as one.
      expect(m.driftSecondsPerMinute).toBeUndefined();
      expect(m.driftSpanSeconds).toBeUndefined();
    }

    // A repeated section is the second shape the finding named: its windows lock
    // onto different repeats, so the slope runs through repeat-hopping points.
    const hopping = Array.from({ length: REPEAT_SEEDS }, (_, s) => alignEnvelopes(repeated(5000 + s))!)
      .filter((m) => (m.windowLagSpreadSeconds ?? 0) > ALIGN_MAX_LAG_SPREAD_SECONDS);
    expect(hopping.length).toBeGreaterThan(0);
    for (const m of hopping) {
      expect(m.windowsMeasured).toBeGreaterThan(0);
      expect(m.driftSecondsPerMinute).toBeUndefined();
    }

    // ── and the arm that must SPEAK ─────────────────────────────────────────
    // The same gate, the other way round: a take that really is drifting, whose
    // windows agree about it, keeps the number that explains its outcome.
    const drifted = Array.from(
      { length: DRIFT_SEEDS },
      (_, s) => alignEnvelopes(drifting(4000 + s, 1.005))!
    );
    for (const m of drifted) {
      expect(m.windowLagSpreadSeconds!).toBeLessThanOrEqual(ALIGN_MAX_LAG_SPREAD_SECONDS);
      expect(m.driftSecondsPerMinute).toBeDefined();
      expect(m.driftSpanSeconds).toBeDefined();
      expect(m.outcome).toBe('weak');
    }
  });

  /**
   * CC2. WHERE THE PROMINENCE FLOOR COMES FROM, now that it cannot come from
   * unrelated audio.
   *
   * A song whose section repeats gives a rival lag one period away that is a
   * GENUINE partial match, so prominence collapses while the peak stays high —
   * and the chosen lag lands on the wrong repeat about half the time. The
   * refusal was always correct; the WORDING was not, because "not believable"
   * is not what happened. This is the population the floor is derived against,
   * and the outcome it produces is `'ambiguous'` with the rivals attached.
   */
  it('derives the prominence floor against a song that repeats itself', () => {
    const p = populationsAt(ALIGN_SMOOTHING_MS);
    const aperiodic = p.cover.map((m) => m.prominence);
    const repeats = Array.from({ length: REPEAT_SEEDS }, (_, s) =>
      alignEnvelopes(repeated(5000 + s))!
    );
    const repeatProminence = repeats.map((m) => m.prominence);
    const repeatPeak = repeats.map((m) => m.peakCorrelation);
    // CC2 fix-round (IMP-1): two metronomes at one tempo are the OTHER
    // several-places population, and the harder one — their prominence ceiling
    // is above the repeated section's, so it is what this floor's lower margin
    // is really measured against.
    const periodicProminence = p.periodic.map((m) => m.prominence);
    // eslint-disable-next-line no-console
    console.log(
      [
        `aperiodic prominence  ${JSON.stringify(span(aperiodic))}`,
        `repeated  prominence  ${JSON.stringify(span(repeatProminence))}`,
        `repeated  peak        ${JSON.stringify(span(repeatPeak))}`,
        `periodic  prominence  ${JSON.stringify(span(periodicProminence))}`,
      ].join('\n  ')
    );
    const worstAperiodic = Math.min(...aperiodic);
    const bestRepeat = Math.max(...repeatProminence, ...periodicProminence);
    expect(bestRepeat).toBeLessThan(worstAperiodic);
    expect(ALIGN_MIN_PROMINENCE - bestRepeat).toBeGreaterThanOrEqual(ALIGN_PROMINENCE_MARGIN);
    expect(worstAperiodic - ALIGN_MIN_PROMINENCE).toBeGreaterThanOrEqual(ALIGN_PROMINENCE_MARGIN);

    for (const m of repeats) {
      // The peak is EXCELLENT — this is not a take with no relation, and saying
      // so was the defect.
      expect(m.peakCorrelation).toBeGreaterThanOrEqual(ALIGN_MIN_CORRELATION);
      expect(m.outcome).toBe('ambiguous');
      expect(m.confident).toBe(false);
      // …and the rivals are carried, guard-separated, so the user can be asked
      // rather than told.
      expect(m.candidates!.length).toBeGreaterThan(1);
      const [first, second] = m.candidates!;
      expect(Math.abs(first.offsetSeconds - second.offsetSeconds)).toBeGreaterThanOrEqual(
        ALIGN_GUARD_SECONDS
      );
      // The rival really is nearly as good — that is WHY this is ambiguous.
      expect(second.correlation).toBeGreaterThan(first.correlation - ALIGN_MIN_PROMINENCE);
      // A repeated section puts its rivals a whole period away, which is the
      // shape of the evidence rather than a coincidence of one seed.
      const gaps = m
        .candidates!.slice(1)
        .map((c) => Math.abs(c.offsetSeconds - first.offsetSeconds));
      expect(Math.min(...gaps)).toBeGreaterThan(REPEAT_PERIOD_SECONDS * 0.5);
    }
  });
});

/**
 * V3. WHERE THE MIX REFINEMENT COMES FROM, and what it is worth.
 *
 * The two passes above both correlate the take against the SEPARATED VOCAL, and
 * a separated vocal is the one signal in the whole journey that has been through
 * a model. The ORIGINAL SONG has been through nothing — and it shares the stem's
 * timeline EXACTLY, because this repo's separation is a decomposition whose
 * parts sum back to the mix bit for bit. So a lag measured against the mix is
 * the same quantity, measured against a cleaner ruler.
 *
 * It is also the ruler that MATTERS, which is the argument this whole stage
 * rests on: the take is going to be heard against the instrumental, i.e. against
 * the song. If the stem's attacks sit late of the song's, a take aligned to the
 * stem is out of time with what will actually be playing — however accurate that
 * alignment is against the stem.
 *
 * The population is the journey's own shape: one performance rendered three ways
 * — the clean vocal, the MIX (vocal plus a band on its own schedule), and the
 * STEM a separator would return (attacks spread by `smearAttacks`, the band's
 * leakage the mask did not remove, and a noise floor) — with the take a second
 * performance of the same schedule at a known lag.
 *
 * BOTH halves are asserted, because only the pair is a reason to ship: the
 * degraded stem's error is recovered, and the CLEAN stem's answer is not made
 * worse.
 */
describe('alignTakeToReference — the mix refinement', () => {
  /** Twelve seconds: long enough for the piecewise arm to speak (four windows)
   * and short enough that six pairs are affordable next to the derivations
   * above. */
  const MIX_SECONDS = 12;
  const MIX_REF_LEAD = 0.9;
  const MIX_TAKE_LEAD = 0.3;
  /** The take's sample 0 on the reference's timeline — the quantity measured. */
  const MIX_TRUTH = MIX_REF_LEAD - MIX_TAKE_LEAD;
  const MIX_SEEDS = 6;

  /**
   * How far the stem's attacks are displaced. 30 ms is not a measurement of this
   * repo's separator and is not claimed to be — see `smearAttacks`. It is the
   * displacement this population is built AROUND, chosen because it is the
   * regime that separates: below ~15 ms the stem path is already inside the
   * mix's own answer and there is nothing to recover, and above ~50 ms the
   * COARSE pass starts failing outright on the degraded stem (measured: one pair
   * in six landed 8.3 s out), which a bounded refinement cannot and should not
   * rescue. That ceiling is a real limit of this stage and it is stated rather
   * than hidden: the mix pass fixes a displaced answer, never a wrong one.
   */
  const SMEAR_TAU_MS = 30;
  /** …and what else the mask left behind: the band 12 dB down, under a floor. */
  const LEAK_DB = -12;
  const STEM_NOISE = 0.03;
  /** How far under the vocal the band sits in the MIX. A vocal 6 dB over the
   * backing is an ordinary pop balance, and deliberately not a flattering one:
   * the mix pass has to win with the band's foreign onsets at full strength. */
  const BAND_DB = -6;

  const floorOf = (seed: number, n: number, amplitude: number): Float32Array => {
    const rng = mulberry32(seed);
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) out[i] = amplitude * (rng() * 2 - 1);
    return out;
  };

  interface Trio {
    /** The separated vocal, with the attacks displaced — what the journey
     * aligns against today. */
    stem: AlignmentEnvelopes;
    /** The same vocal with nothing done to it — the no-regression control. */
    clean: AlignmentEnvelopes;
    /** The original song: vocal plus band, no model in between. */
    mix: AlignmentEnvelopes;
    take: AlignmentEnvelopes;
  }

  const trioCache = new Map<number, Trio>();
  afterAll(() => trioCache.clear());

  function trio(seed: number): Trio {
    const hit = trioCache.get(seed);
    if (hit) return hit;
    const vocal = makeVocalLike({
      seed,
      sampleRate: 44100,
      seconds: MIX_SECONDS,
      leadSeconds: MIX_REF_LEAD,
    })[0];
    // A different schedule: the band is not singing the vocal line, so its
    // onsets are foreign to the mix as well as to the stem.
    const band = makeVocalLike({
      seed: seed * 31 + 7,
      sampleRate: 44100,
      seconds: MIX_SECONDS,
      leadSeconds: MIX_REF_LEAD,
    })[0];
    const leak = Math.pow(10, LEAK_DB / 20);
    const bandGain = Math.pow(10, BAND_DB / 20);
    const floor = floorOf(seed * 5 + 1, vocal.length, STEM_NOISE);
    const smeared = smearAttacks(vocal, 44100, SMEAR_TAU_MS);
    const stem = Float32Array.from(smeared, (v, i) => v + leak * (band[i] ?? 0) + floor[i]);
    const mixed = Float32Array.from(vocal, (v, i) => v + bandGain * (band[i] ?? 0));
    const take = makeVocalLike({
      seed,
      sampleRate: 48000,
      seconds: MIX_SECONDS,
      leadSeconds: MIX_TAKE_LEAD,
      hzScale: 1.26,
      amplitudeJitter: 0.5,
      noiseAmplitude: 0.012,
      varianceSeed: seed * 7 + 3,
      timingJitterSeconds: 0.02,
      timingSeed: seed * 3 + 17,
    });
    const built: Trio = {
      stem: alignmentOdf([stem], 44100)!,
      clean: alignmentOdf([vocal], 44100)!,
      mix: alignmentOdf([mixed], 44100)!,
      take: alignmentOdf(take, 48000)!,
    };
    trioCache.set(seed, built);
    return built;
  }

  interface Row {
    /** |offset − truth| with the stem as the only reference. */
    stemOnly: number;
    /** …and with the mix refinement on top of it. */
    refined: number;
    /** The control: the stem replaced by the undegraded vocal. */
    cleanOnly: number;
    cleanRefined: number;
    /** How far the mix pass moved the winner — the distance the window has to
     * span, which is what the window is derived against. */
    moved: number;
    /** How far apart the two REFINED answers are. The property the whole stage
     * is for: the song decides the lag, whatever state the stem is in. */
    agreement: number;
  }

  let population: Row[] | null = null;
  function rows(): Row[] {
    if (population) return population;
    population = [];
    for (let s = 0; s < MIX_SEEDS; s++) {
      const t = trio(900 + s);
      const stemOnly = alignEnvelopes({ a: t.stem, b: t.take })!;
      const refined = alignEnvelopes({ a: t.stem, b: t.take, mix: t.mix })!;
      const cleanOnly = alignEnvelopes({ a: t.clean, b: t.take })!;
      const cleanRefined = alignEnvelopes({ a: t.clean, b: t.take, mix: t.mix })!;
      population.push({
        stemOnly: Math.abs(stemOnly.offsetSeconds - MIX_TRUTH),
        refined: Math.abs(refined.offsetSeconds - MIX_TRUTH),
        cleanOnly: Math.abs(cleanOnly.offsetSeconds - MIX_TRUTH),
        cleanRefined: Math.abs(cleanRefined.offsetSeconds - MIX_TRUTH),
        moved: Math.abs(refined.mixRefinementSeconds!),
        agreement: Math.abs(refined.offsetSeconds - cleanRefined.offsetSeconds),
      });
    }
    return population;
  }

  const worst = (v: number[]) => Number(Math.max(...v).toFixed(4));
  const middle = (v: number[]) =>
    Number([...v].sort((x, y) => x - y)[Math.floor(v.length / 2)].toFixed(4));
  const ms = (v: number) => `${(v * 1000).toFixed(2)} ms`;

  /**
   * V3. WHERE `ALIGN_MIX_REFINE_SECONDS` COMES FROM.
   *
   * The window is not a taste: it is the distance the pass BEFORE it can be
   * wrong by. The mix pass is handed the stem path's answer and may only look
   * around it, so the half-width has to cover the distance it actually travels —
   * with margin — and no more, because every further metre is a metre in which
   * the mix's own strongest local rival can win instead.
   */
  it('derives the mix window from the distance the stem path actually leaves', () => {
    const p = rows();
    const travelled = p.map((r) => r.moved);
    const errors = p.map((r) => r.stemOnly);
    // eslint-disable-next-line no-console
    console.log(
      `mix pass travelled: median ${ms(middle(travelled))}, worst ${ms(worst(travelled))} over ${p.length} pairs\n` +
        `  stem-path error:    median ${ms(middle(errors))}, worst ${ms(worst(errors))}\n` +
        `  window ${ALIGN_MIX_REFINE_SECONDS} s, margin ${ALIGN_MIX_REFINE_MARGIN} s, guard ${ALIGN_GUARD_SECONDS} s`
    );
    // Wide enough to contain the travel it has to make, by the stated margin…
    expect(ALIGN_MIX_REFINE_SECONDS).toBeGreaterThanOrEqual(
      worst(travelled) + ALIGN_MIX_REFINE_MARGIN
    );
    // …and the stem path's own error against ground truth, on the same margin,
    // because a window that only just holds the observed travel is a window the
    // next noisier pair escapes from.
    expect(ALIGN_MIX_REFINE_SECONDS).toBeGreaterThanOrEqual(
      worst(errors) + ALIGN_MIX_REFINE_MARGIN
    );
    // …and narrow enough that it cannot reach a rival the coarse pass separated:
    // candidates are a full guard apart, so a window of half a guard can never
    // let one candidate's refinement land on another's lag.
    expect(ALIGN_MIX_REFINE_SECONDS).toBeLessThanOrEqual(ALIGN_GUARD_SECONDS / 2);
    // The travel is not being clipped BY the window, which would make the figure
    // above a measurement of the constant rather than of the signal.
    expect(worst(travelled)).toBeLessThan(ALIGN_MIX_REFINE_SECONDS);
  });

  /**
   * V3. What the third pass is WORTH — the user's "still a little off", as a
   * number.
   *
   * Note what is NOT claimed: neither arm meets the ±10 ms this module publishes
   * elsewhere, and that is the population rather than the pass. These takes are
   * a SECOND PERFORMANCE with ±20 ms of per-syllable timing of their own, so the
   * lag that best matches two onset envelopes is not exactly the lag the fixture
   * was built at. The claim is the DIFFERENCE between the two arms, measured on
   * one population, in both the median and the worst case.
   */
  it('recovers offset error that the displaced stem attacks leave behind', () => {
    const p = rows();
    // eslint-disable-next-line no-console
    console.log(
      `stem-only  median ${ms(middle(p.map((r) => r.stemOnly)))}  worst ${ms(worst(p.map((r) => r.stemOnly)))}\n` +
        `  refined    median ${ms(middle(p.map((r) => r.refined)))}  worst ${ms(worst(p.map((r) => r.refined)))}`
    );
    // Both ends improve. A median that improves while one pair gets much worse
    // would be a refinement nobody should ship, so the worst case is asserted
    // too — and by a stated amount, not merely "less than".
    expect(middle(p.map((r) => r.stemOnly)) - middle(p.map((r) => r.refined))).toBeGreaterThan(
      0.004
    );
    expect(worst(p.map((r) => r.stemOnly)) - worst(p.map((r) => r.refined))).toBeGreaterThan(0.004);
    // One pair of the six ends 4.0 ms FURTHER from the fixture's nominal truth,
    // and that is the objective rather than a regression being tolerated: the
    // refined lag is the SONG's optimum (see the agreement test below), so where
    // a degraded stem happened to sit closer to the nominal 0.6 s than the
    // song's own optimum does, moving to the song's answer moves away from that
    // number. It is bounded at one fine frame and printed rather than hidden, so
    // a change that started genuinely damaging pairs still fails here.
    const regression = Math.max(...p.map((r) => r.refined - r.stemOnly));
    // eslint-disable-next-line no-console
    console.log(`  worst single-pair move away from nominal truth: ${ms(regression)}`);
    expect(regression).toBeLessThanOrEqual(1 / ALIGN_FRAME_RATE_HZ);
  });

  /**
   * V3. The other half, and the one a refinement usually fails: a reference that
   * was ALREADY right must not be moved off it. The control is the same take
   * against the undegraded vocal, with and without the mix pass.
   */
  it('does not move a clean reference off an answer that was already right', () => {
    const p = rows();
    // eslint-disable-next-line no-console
    console.log(
      `clean stem: unrefined median ${ms(middle(p.map((r) => r.cleanOnly)))} worst ${ms(worst(p.map((r) => r.cleanOnly)))}, ` +
        `refined median ${ms(middle(p.map((r) => r.cleanRefined)))} worst ${ms(worst(p.map((r) => r.cleanRefined)))}`
    );
    // No pair is made worse by more than a coarse frame, and the population's
    // two summary figures do not regress at all.
    expect(worst(p.map((r) => r.cleanRefined))).toBeLessThanOrEqual(worst(p.map((r) => r.cleanOnly)));
    expect(middle(p.map((r) => r.cleanRefined))).toBeLessThanOrEqual(
      middle(p.map((r) => r.cleanOnly))
    );
  });

  /**
   * V3. The property the stage exists for, said directly: after the mix pass the
   * lag is the SONG's, not the stem's. The same take refined against the same
   * song lands in the same place whether the stem it started from was degraded
   * or pristine — which is what "align to the original song" has to mean if it
   * means anything.
   */
  it('makes the placed lag the song\'s answer rather than the stem\'s', () => {
    const p = rows();
    // eslint-disable-next-line no-console
    console.log(
      `degraded-vs-clean after refinement: worst ${ms(worst(p.map((r) => r.agreement)))}; ` +
        `before it, the same pairs differed by up to ${ms(worst(p.map((r) => Math.abs(r.stemOnly - r.cleanOnly))))}`
    );
    // One fine frame is 5 ms; the two paths agree far inside it.
    expect(worst(p.map((r) => r.agreement))).toBeLessThan(1 / ALIGN_FRAME_RATE_HZ);
  });

  /**
   * V3. The reporting contract. A row that says −8.257 s while −8.243 s was
   * placed is the defect this task exists to remove, so the refinement rides the
   * measurement rather than being applied somewhere downstream: the offset IS
   * the refined one, and how far the mix moved it is stated.
   */
  it('reports the refined offset and how far the mix pass moved it', () => {
    const t = trio(900);
    const without = alignEnvelopes({ a: t.stem, b: t.take })!;
    const withMix = alignEnvelopes({ a: t.stem, b: t.take, mix: t.mix })!;

    expect(without.refinedAgainstMix).toBe(false);
    expect(without.mixRefinementSeconds).toBeUndefined();
    expect(withMix.refinedAgainstMix).toBe(true);
    // The delta is measured from the pass it corrects, not from the coarse lag:
    // it is what the mix pass ADDED, so a caller can say "the separated vocal
    // put it here, the song itself moved it that far".
    expect(withMix.mixRefinementSeconds).toBeCloseTo(
      withMix.offsetSeconds - without.offsetSeconds,
      12
    );
    expect(withMix.mixRefinementSeconds).not.toBe(0);

    // The mix REFINES; it never re-decides. Everything the confidence arm is
    // made of is still the stem's, untouched, so no threshold in this file
    // moves because this stage exists.
    expect(withMix.coarseOffsetSeconds).toBe(without.coarseOffsetSeconds);
    expect(withMix.peakCorrelation).toBe(without.peakCorrelation);
    expect(withMix.prominence).toBe(without.prominence);
    expect(withMix.outcome).toBe(without.outcome);
    expect(withMix.windowsMeasured).toBe(without.windowsMeasured);
  });

  /**
   * V3 (R3). ONE refinement entry point. Whatever the user ends up placing — the
   * winner the pass auto-places, or a rival they click instead — has been
   * through the same two refinement stages, so no arm can drift from another.
   */
  it('sends every candidate through the same refinement the winner got', () => {
    const period = 6;
    const chorus = (leadSeconds: number, jitterSeed: number) =>
      makeVocalLike({
        seed: 55,
        sampleRate: RATE,
        seconds: period * 3,
        leadSeconds,
        repeatPeriodSeconds: period,
        timingJitterSeconds: 0.02,
        timingSeed: jitterSeed,
      });
    const reference = chorus(0.9, 1);
    const take = chorus(0.3, 2);
    // The mix is that reference plus a band, on the reference's own timeline.
    const band = makeVocalLike({
      seed: 4242,
      sampleRate: RATE,
      seconds: period * 3,
      leadSeconds: 0.9,
    })[0];
    const bandGain = Math.pow(10, BAND_DB / 20);
    const mixed = [Float32Array.from(reference[0], (v, i) => v + bandGain * (band[i] ?? 0))];

    const without = alignTakeToReference(reference, RATE, take, RATE)!;
    const withMix = alignTakeToReference(reference, RATE, take, RATE, {
      channels: mixed,
      sampleRate: RATE,
    })!;
    // The outcome is the stem's verdict either way — this is the arm that lists
    // rivals, which is what makes it the one worth checking.
    expect(withMix.outcome).toBe(without.outcome);
    expect(withMix.candidates).toBeDefined();
    expect(withMix.candidates!.length).toBe(without.candidates!.length);
    expect(withMix.candidates!.length).toBeGreaterThan(1);
    // The list still leads with the answer the measurement reports…
    expect(withMix.candidates![0].offsetSeconds).toBe(withMix.offsetSeconds);
    // …every one of them moved, so none was left holding the unrefined lag the
    // row beside it would then have been promising…
    for (const [i, c] of withMix.candidates!.entries()) {
      expect(c.offsetSeconds).not.toBe(without.candidates![i].offsetSeconds);
    }
    // …and the guard separation survives the second refinement, which is the
    // contract a picker offering three rows depends on.
    const offsets = withMix.candidates!.map((c) => c.offsetSeconds);
    for (let i = 0; i < offsets.length; i++) {
      for (let j = i + 1; j < offsets.length; j++) {
        expect(Math.abs(offsets[i] - offsets[j])).toBeGreaterThanOrEqual(ALIGN_GUARD_SECONDS);
      }
    }
  });

  /**
   * V3. The mix is OPTIONAL, and a caller that cannot supply one loses only the
   * third pass. A mix with no onset in it (or too short to frame) is the same
   * case: it must not take the whole measurement down with it.
   */
  it('measures exactly as before when no usable mix is given', () => {
    const t = trio(901);
    const plain = alignEnvelopes({ a: t.stem, b: t.take })!;
    const nulled = alignEnvelopes({ a: t.stem, b: t.take, mix: null })!;
    expect(nulled.offsetSeconds).toBe(plain.offsetSeconds);
    expect(nulled.refinedAgainstMix).toBe(false);
    // …and through the top-level entry point, where the mix is a document that
    // may simply have nothing in it.
    const silent = alignTakeToReference(
      makeVocalLike({ seed: 7, sampleRate: RATE, seconds: 6, leadSeconds: 1.4 }),
      RATE,
      makeVocalLike({ seed: 7, sampleRate: RATE, seconds: 6, leadSeconds: 0.2 }),
      RATE,
      { channels: [new Float32Array(RATE * 6)], sampleRate: RATE }
    );
    expect(silent).not.toBeNull();
    expect(silent!.refinedAgainstMix).toBe(false);
    expect(Math.abs(silent!.offsetSeconds - 1.2)).toBeLessThan(TOLERANCE_SECONDS);
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
