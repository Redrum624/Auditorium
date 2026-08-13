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
  alignEnvelopes,
  alignmentOdf,
  alignTakeToReference,
  type AlignmentEnvelopes,
  type AlignmentMeasurement,
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
    for (const other of [take, stranger]) {
      const r = alignTakeToReference(reference, RATE, other, RATE)!;
      expect(r.confident).toBe(r.outcome === 'confident');
      expect(r.candidates).toBeDefined();
      expect(r.candidates!.length).toBeGreaterThan(0);
      expect(r.candidates!.length).toBeLessThanOrEqual(ALIGN_CANDIDATE_COUNT);
      expect(r.candidates![0].offsetSeconds).toBe(r.offsetSeconds);
      expect(r.candidates![0].correlation).toBeCloseTo(r.peakCorrelation, 12);
      expect(r.candidates![0].prominence).toBeCloseTo(r.prominence, 12);
      // Guard-separated, in descending order of correlation, every pair.
      for (let i = 1; i < r.candidates!.length; i++) {
        expect(r.candidates![i].correlation).toBeLessThanOrEqual(r.candidates![i - 1].correlation);
        for (let j = 0; j < i; j++) {
          expect(
            Math.abs(r.candidates![i].offsetSeconds - r.candidates![j].offsetSeconds)
          ).toBeGreaterThanOrEqual(ALIGN_GUARD_SECONDS - 2 * ALIGN_REFINE_SECONDS);
        }
      }
    }
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

  const span = (v: number[]) => ({
    min: Number(Math.min(...v).toFixed(4)),
    max: Number(Math.max(...v).toFixed(4)),
  });

  interface Population {
    cover: AlignmentMeasurement[];
    unrelated: AlignmentMeasurement[];
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
    return { cover, unrelated: unrel };
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
    // audio now. The prominence gap against this population has CLOSED at the
    // smoothing width the correlation arm needs — measured, an unrelated pair
    // reaches 0.237 while the worst cover reaches 0.247 — and that is stated
    // rather than papered over: prominence stopped being able to carry
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
    expect(bestUnrelatedProminence).toBeGreaterThan(0);

    // The fine pass is a REFINEMENT, not a second opinion. The clamp is
    // structural (the window is what `lagSurface` is given), so asserting it
    // alone could never fail — measured, the refinement moves 3.2-6.4 ms against
    // a 200 ms clamp, 31x of slack. Both are asserted: the structural bound for
    // what it guarantees, and the MEASURED bound so the assertion has teeth.
    expect(Math.max(...relatedRefinement)).toBeLessThanOrEqual(ALIGN_REFINE_SECONDS);
    expect(Math.max(...relatedRefinement)).toBeLessThan(0.05);

    // The ±10 ms requirement is pinned by the ground-truth cases above, where
    // the take IS the reference at a known offset and the answer is not a
    // matter of opinion. THIS population is harder and its residual is stated
    // rather than asserted away: two different performances of one schedule
    // disagree about where a syllable starts, and a human one disagrees by the
    // ±40 ms the fixture now draws. The ceiling is on that disagreement, not a
    // restatement of the requirement — and it is BELOW the jitter itself, which
    // is the point: the aligner averages the variance out rather than following
    // any one syllable.
    expect(Math.max(...relatedError)).toBeLessThan(HUMAN_JITTER_SECONDS);
  });

  it('every related pair is accepted and every unrelated pair refused', () => {
    const p = populationsAt(ALIGN_SMOOTHING_MS);
    for (const m of p.cover) expect(m.outcome).toBe('confident');
    for (const m of p.unrelated) expect(m.outcome).toBe('unrelated');
    // The half that matters: a cover sung by a human being, refused before CC2.
    expect(p.cover.slice(SEEDS)).toHaveLength(JITTER_SEEDS);
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
    expect(Math.max(...error(mild))).toBeLessThan(0.05);
    expect(Math.max(...error(mild))).toBeGreaterThan(Math.max(...error(control)));
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
    // eslint-disable-next-line no-console
    console.log(
      [
        `aperiodic prominence  ${JSON.stringify(span(aperiodic))}`,
        `repeated  prominence  ${JSON.stringify(span(repeatProminence))}`,
        `repeated  peak        ${JSON.stringify(span(repeatPeak))}`,
      ].join('\n  ')
    );
    const worstAperiodic = Math.min(...aperiodic);
    const bestRepeat = Math.max(...repeatProminence);
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
