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
 * V3 fix-round-2. WHY THE REFERENCE IS THE SEPARATED VOCAL AND NOT THE SONG.
 *
 * V3 shipped a third pass that refined the stem passes' answer against the
 * ORIGINAL SONG, on the reasoning that the song has not been through a
 * separation model and shares the stem's timeline bit for bit. The packaged
 * smoke caught it: on the shared-onset fixture pair, a placement the stem path
 * had exact to 0.06 ms came back 13.03 ms out — past the ±10 ms this module
 * publishes.
 *
 * This block is that measurement, kept. Sharing a TIMELINE is not sharing
 * ONSETS: an onset envelope is spectral flux, and accompaniment under a vocal
 * dilutes the flux at the vocal's own attacks, so the mix's onsets land late of
 * the same vocal's by an amount that grows with the accompaniment. The stem does
 * not have that problem, because the bed is not in it.
 *
 * The fixture is the packaged smoke's own shape, built from this module's
 * fixture machinery rather than a third copy of `make-test-cover.cjs`: one
 * syllable schedule rendered as the song's vocal, a tilted-noise bed under it at
 * a controlled level, and the SAME schedule rendered again as the take with its
 * own pitches, dynamics and a known lead. The stem is the vocal exactly, which
 * is what that fixture ships (its five stems sum to the mix, four of them
 * silent).
 */
describe('alignTakeToReference — the reference is the stem, and here is why', () => {
  // ── COUPLED TO `scripts/make-test-cover.cjs`, AND NOTHING ENFORCES IT ───────
  //
  // Every constant in this block is a hand-matched copy of one in that script,
  // because the script may not import app code (it must run under bare `node`)
  // and this suite may not shell a generator. The reconstruction is what makes
  // the packaged smoke's exact property assertable here, in 8 s, instead of only
  // through a build — but it is held together by nothing except this comment, so
  // a change to EITHER side silently desyncs them: the script would ship one
  // fixture while this block went on measuring another, both green.
  //
  // The pairs, in full:
  //
  //   this block                     make-test-cover.cjs
  //   SEED                  0x51d3a7  SYNC_SCHEDULE_SEED           0x51d3a7
  //   SONG_VARIANCE_SEED    0x1a2b3c  SYNC_SONG_VARIANCE_SEED      0x1a2b3c
  //   TAKE_VARIANCE_SEED    0x4d5e6f  SYNC_TAKE_VARIANCE_SEED      0x4d5e6f
  //   BED_SEED              0x7c4e11  sourceNoise(0x7c4e11)
  //   tiltedNoise coeff          0.7  tilt(…, 0.7)
  //   hzScale                   1.06  SYNC_TAKE_HZ_SCALE           1.06
  //   amplitudeJitter           0.25  SYNC_TAKE_AMPLITUDE_JITTER   0.25
  //   MIX_LEAD_SECONDS          0.75  SYNC_OFFSET_SECONDS          0.75
  //                                     (now in cover-fixture-manifest.cjs)
  //   SMOKE_BED_DB_UNDER_VOCAL   -14  SYNC_BED_RMS_DBFS -32 MINUS
  //                                     SYNC_VOCAL_RMS_DBFS -18
  //   MIX_RATE                 48000  SAMPLE_RATE                  48000
  //   MIX_SECONDS                  6  SECONDS                      6
  //
  // Change one side and change the other. The offset is the one pair that IS
  // bound at its own end — `make-test-cover.cjs` and `e2e-smoke.cjs` now read it
  // from `scripts/cover-fixture-manifest.cjs`, so the plant and the smoke's
  // assertion cannot drift from each other — but that binding does not extend
  // here: this is a renderer unit suite and it does not reach into `scripts/`,
  // so `MIX_LEAD_SECONDS` remains a copy and stays on this list.
  const MIX_RATE = 48000;
  const MIX_SECONDS = 6;
  /** The take's lead, and therefore MINUS the offset the aligner must report:
   * a take carrying 0.75 s of extra silence has to start 0.75 s EARLIER for its
   * syllables to land on the song's. The packaged fixture's own constant. */
  const MIX_LEAD_SECONDS = 0.75;
  const MIX_TRUTH = -MIX_LEAD_SECONDS;
  /** The packaged fixture's own balance: a −18 dBFS vocal over a −32 dBFS bed. */
  const SMOKE_BED_DB_UNDER_VOCAL = -14;

  const rmsOf = (x: Float32Array): number => {
    let sum = 0;
    for (let i = 0; i < x.length; i++) sum += x[i] * x[i];
    return Math.sqrt(sum / x.length);
  };

  /** `y[n] = x[n] + k·x[n−1]` over seeded white noise — the packaged fixture's
   * own bed, a first-order tilt that darkens rather than a flat spectrum, so the
   * dilution being measured is not an artefact of a uniform noise floor. */
  const tiltedNoise = (seed: number, length: number, coefficient: number): Float32Array => {
    const rng = mulberry32(seed);
    const out = new Float32Array(length);
    let previous = 0;
    for (let i = 0; i < length; i++) {
      const x = rng() * 2 - 1;
      out[i] = x + coefficient * previous;
      previous = x;
    }
    return out;
  };

  /**
   * The packaged fixture's own variance seeds and pitch/dynamics knobs, so the
   * signals below are the ones `make-test-cover.cjs` writes rather than
   * something merely similar. Its renderer is a deliberate copy of this
   * module's fixture machinery -- the script may not import app code, and says
   * so -- which is why the same schedule, the same PRNG and the same three
   * harmonics can be reached from here through `makeVocalLike` instead of a
   * third copy. The one difference is the buffer: the script renders into a
   * FIXED six seconds and drops what runs past the end, so the take is
   * truncated below to match.
   */
  const SONG_VARIANCE_SEED = 0x1a2b3c;
  const TAKE_VARIANCE_SEED = 0x4d5e6f;
  const BED_SEED = 0x7c4e11;

  const vocalOf = (seed: number) =>
    makeVocalLike({
      seed,
      sampleRate: MIX_RATE,
      seconds: MIX_SECONDS,
      varianceSeed: SONG_VARIANCE_SEED,
    })[0];

  /** The same schedule, sung again: other pitches, other dynamics, laid down
   * `MIX_LEAD_SECONDS` later and truncated to the song's own length. */
  const takeOf = (seed: number) => [
    makeVocalLike({
      seed,
      sampleRate: MIX_RATE,
      seconds: MIX_SECONDS,
      leadSeconds: MIX_LEAD_SECONDS,
      hzScale: 1.06,
      amplitudeJitter: 0.25,
      varianceSeed: TAKE_VARIANCE_SEED,
    })[0].subarray(0, MIX_RATE * MIX_SECONDS),
  ];

  /** vocal + bed, with the bed set to `dbUnderVocal` of the vocal's own RMS. */
  const mixOf = (vocal: Float32Array, dbUnderVocal: number): Float32Array[] => {
    const bed = tiltedNoise(BED_SEED, vocal.length, 0.7);
    const scale = (rmsOf(vocal) * Math.pow(10, dbUnderVocal / 20)) / rmsOf(bed);
    return [Float32Array.from(vocal, (v, i) => v + bed[i] * scale)];
  };

  const envCache = new Map<string, AlignmentEnvelopes>();
  afterAll(() => envCache.clear());
  const env = (key: string, build: () => Float32Array[]): AlignmentEnvelopes => {
    const hit = envCache.get(key);
    if (hit) return hit;
    const built = alignmentOdf(build(), MIX_RATE)!;
    expect(built).not.toBeNull();
    envCache.set(key, built);
    return built;
  };

  const SEED = 0x51d3a7;
  const stemEnv = () => env('stem', () => [vocalOf(SEED)]);
  const takeEnv = () => env('take', () => takeOf(SEED));
  const mixEnv = (dbUnderVocal: number) =>
    env(`mix/${dbUnderVocal}`, () => mixOf(vocalOf(SEED), dbUnderVocal));

  /** Where the take lands, in seconds of error against the built-in truth. */
  const errorAgainst = (reference: AlignmentEnvelopes): number =>
    alignEnvelopes({ a: reference, b: takeEnv() })!.offsetSeconds - MIX_TRUTH;
  /** Where the STEM's own sample 0 lands on the MIX's timeline. Zero if the two
   * shared their onsets; it does not. */
  const stemOnMix = (dbUnderVocal: number): number =>
    alignEnvelopes({ a: mixEnv(dbUnderVocal), b: stemEnv() })!.offsetSeconds;

  const ms = (v: number) => `${(v * 1000).toFixed(2)} ms`;
  /** The bed levels the derivation sweeps, relative to the vocal. Stops at 8 dB
   * under: below that the accompaniment starts winning the correlation outright
   * (measured on the packaged fixture at 2 dB under: −49 ms, and the stem-on-mix
   * lag −44 ms), which is a different failure and not the one being derived. */
  const BED_SWEEP = [-52, -42, -32, -22, -18, -14, -8];

  /**
   * The regression the packaged smoke caught, pinned here where it costs seconds
   * instead of a build. This is the fixture pair's own property: a take that is
   * a second performance of the song's own schedule is placed on the SEPARATED
   * VOCAL to well inside the published tolerance.
   */
  it('recovers the packaged smoke pair\'s offset to well inside the published ±10 ms', () => {
    const error = errorAgainst(stemEnv());
    // eslint-disable-next-line no-console
    console.log(`smoke-shape pair: truth ${MIX_TRUTH} s, error ${ms(error)}`);
    expect(Math.abs(error)).toBeLessThan(TOLERANCE_SECONDS);
    // …and with real teeth, because the measured figure is two orders under the
    // published tolerance and a regression that merely stayed inside 10 ms would
    // still be one. V3's third pass landed 13.03 ms here.
    expect(Math.abs(error)).toBeLessThan(0.002);
  });

  /**
   * The property that makes the stem the right reference: the accompaniment is
   * not in it, so no amount of accompaniment moves the answer.
   */
  it('places identically whatever the accompaniment is doing, because it is not the reference', () => {
    // The reference never changes across this sweep — that IS the point, and the
    // assertion is that the answer does not either.
    const error = errorAgainst(stemEnv());
    for (const db of BED_SWEEP) {
      // Building each mix proves the sweep is real rather than a loop over one
      // cached number; the stem path simply never consults it.
      expect(mixEnv(db).fine.length).toBeGreaterThan(0);
    }
    expect(Math.abs(error)).toBeLessThan(0.002);
  });

  /**
   * WHY THE THIRD PASS WAS REMOVED, as a table rather than an opinion.
   *
   * Refining against the song was measured, shipped, and caught by the packaged
   * smoke. Two columns say everything: the error a mix-refined answer carries,
   * and the lag between the stem's own onsets and the mix's. They are the SAME
   * NUMBER at every bed level, because the pass's entire effect was to move the
   * placement onto a ruler whose zero had moved — by exactly the amount the zero
   * had moved. It recovered nothing about the take.
   *
   * That identity is also why no correction exists. The only way to measure the
   * bias is the stem-on-mix lag, and subtracting it from the mix's answer
   * returns the stem's answer, which is where the pass started.
   */
  it('rejects the original song as a ruler: the error it adds IS the accompaniment', () => {
    const rows = BED_SWEEP.map((db) => ({
      db,
      mixError: errorAgainst(mixEnv(db)),
      displacement: stemOnMix(db),
    }));
    // eslint-disable-next-line no-console
    console.log(
      ['bed vs vocal   mix-refined error   stem-on-mix lag']
        .concat(
          rows.map(
            (r) =>
              `${String(r.db).padStart(9)} dB   ${ms(r.mixError).padStart(16)}   ${ms(r.displacement).padStart(15)}`
          )
        )
        .join('\n  ')
    );

    // 1. The bias is real at every level, and it GROWS with the accompaniment —
    //    so it is the accompaniment, not a constant offset in the fixture.
    const quietest = rows[0];
    const loudest = rows[rows.length - 1];
    expect(Math.abs(loudest.mixError)).toBeGreaterThan(Math.abs(quietest.mixError));
    // 2. It does not conveniently vanish for a quiet bed: 52 dB under the vocal
    //    still costs milliseconds.
    expect(Math.abs(quietest.mixError)).toBeGreaterThan(0.002);
    // 3. At the packaged fixture's own balance it exceeds the published
    //    tolerance outright, which is the shipped defect the smoke caught.
    const smoke = rows.find((r) => r.db === SMOKE_BED_DB_UNDER_VOCAL)!;
    expect(Math.abs(smoke.mixError)).toBeGreaterThan(TOLERANCE_SECONDS);
    // 4. THE MECHANISM: the error a mix ruler adds is the displacement between
    //    the two rulers, to well inside one frame of the grid they are measured
    //    on. This is the assertion that makes the table an explanation rather
    //    than a coincidence, and the one that says no correction is possible.
    for (const r of rows) {
      expect(Math.abs(r.mixError - r.displacement)).toBeLessThan(1 / ALIGN_COARSE_FRAME_RATE_HZ);
    }
  });

  /**
   * The case V3's third pass was BUILT for, measured against the thing it was
   * built to beat — and losing.
   *
   * A stem whose attacks the model has spread is the whole motivation: its
   * onsets are displaced, so the placement is displaced with them. That cost is
   * real and this test states it as a number rather than implying it away. But
   * the song is not the cure, and this is the sharpest form of the finding: even
   * on a DEGRADED stem, the degraded stem beats the song. Swapping one for the
   * other does not trade a large error for a small one; it trades a small error
   * for a larger one.
   */
  it('beats the song even from a DISPLACED stem, which is what removed the third pass', () => {
    const displaced = env('smeared', () => [smearAttacks(vocalOf(SEED), MIX_RATE, 30)]);
    const error = errorAgainst(displaced);
    const mixError = errorAgainst(mixEnv(SMOKE_BED_DB_UNDER_VOCAL));
    // eslint-disable-next-line no-console
    console.log(
      `a stem whose attacks are spread 30 ms places the take ${ms(error)} out; ` +
        `the song, at this fixture's balance, is ${ms(mixError)} out on its own`
    );
    // The displacement costs real accuracy. It is a genuine limitation of taking
    // the separated vocal as the ruler, and nothing here fixes it.
    expect(Math.abs(error)).toBeGreaterThan(0.002);
    // …and yet it is still the BETTER of the two rulers, by a stated factor. The
    // third pass replaced this answer with the other one.
    expect(Math.abs(mixError)).toBeGreaterThan(Math.abs(error) * 2);
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
