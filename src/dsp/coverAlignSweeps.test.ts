// T3 fix round 1 (I2) — the DERIVATION SWEEPS, lifted out of `coverAlign.test.ts`
// verbatim so Jest can run them against the rest of that file instead of behind it.
//
// Nothing here is opt-in and nothing is skipped: this is an ordinary `*.test.ts`
// under the renderer project's `roots: [<rootDir>/src]`, so `--listTests` names it
// and every gate run executes it. The split is about WALL TIME, not about running
// less — this block was 250 s of a 262 s suite, so on one worker the other 50 s of
// alignment tests sat behind it for no reason.
//
// The memoisation moves WITH the block rather than being shared across the split:
// `sideCache`, `envelopeCache` and `populationCache` are declared inside this
// describe and every consumer of them is in here too, so each file keeps its own
// caches and neither pays for the other's fixtures. What IS shared is the fixture
// BUILDER — `makeVocalLike` and friends are imported from
// `./__fixtures__/coverAlignFixtures`, exactly as before — so the populations are
// built from the same code and the derived constants are the same constants.

import {
  ALIGN_GUARD_SECONDS,
  ALIGN_MIN_CORRELATION,
  ALIGN_MIN_PROMINENCE,
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
  type AlignmentEnvelopes,
  type AlignmentMeasurement,
} from './coverAlign';
import {
  makeVocalLike,
  mulberry32,
} from './__fixtures__/coverAlignFixtures';

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
  /**
   * T3. The same thing keyed per SIDE rather than per pair, for the
   * constructions where one side is shared and the pair key hid it.
   *
   * Profiled: 98 % of this file's runtime is building these envelopes, not
   * correlating them — one population of 56 ten-second pairs costs 125 s cold
   * and 1.5 s warm, and inside a pair `alignmentOdf` is ~70 % against
   * `makeVocalLike`'s ~30 %. So every avoided ODF is the whole saving, and a
   * pair key that varies on a parameter only the TAKE reads pays for the
   * reference again each time.
   *
   * `drifting` is where that bites: three tempo scales over four seeds is
   * twelve pairs and twelve pair keys, but only FOUR distinct references —
   * `tempoScale` and `timingJitterSeconds` are applied to the take alone. The
   * eight extra references were 20 s of audio each, built and framed for
   * nothing.
   *
   * The key must name every parameter its side's samples depend on, or two
   * different signals collide on one entry. The reference reads
   * `referenceSeed`, `seconds` and `repeatPeriodSeconds` and nothing else: its
   * rate and lead are fixed here, and with `amplitudeJitter` and
   * `noiseAmplitude` both 0 the variance stream is drawn but multiplies out, so
   * `varianceSeed` cannot reach the samples. The take reads all of those plus
   * `varianceSeed`, `tempoScale` and `timingJitterSeconds` (`timingSeed` is
   * derived from `varianceSeed`, so it is covered).
   */
  const sideCache = new Map<string, AlignmentEnvelopes>();
  // The caches are what make a smoothing-width sweep affordable, and they are
  // also the largest thing this file holds; dropping them at the end lets the
  // worker exit with its hands empty rather than at its high-water mark.
  afterAll(() => {
    envelopeCache.clear();
    sideCache.clear();
  });

  /** One side's envelopes, framed once per distinct construction. */
  function sideEnvelopes(
    key: string,
    build: () => Float32Array[],
    rate: number
  ): AlignmentEnvelopes {
    const hit = sideCache.get(key);
    if (hit) return hit;
    const env = alignmentOdf(build(), rate);
    expect(env).not.toBeNull();
    sideCache.set(key, env!);
    return env!;
  }

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
    // T3: keyed per side. The reference's key omits the three take-only knobs
    // BECAUSE its samples cannot see them, which is the whole saving; see
    // `sideCache`.
    const a = sideEnvelopes(
      `ref/${referenceSeed}/${seconds}/${repeatPeriodSeconds}`,
      () =>
        makeVocalLike({
          seed: referenceSeed,
          sampleRate: 44100,
          seconds,
          leadSeconds: 0.9,
          repeatPeriodSeconds,
        }),
      44100
    );
    const b = sideEnvelopes(
      `take/${takeSeed}/${varianceSeed}/${timingJitterSeconds}/${tempoScale}/${seconds}/${repeatPeriodSeconds}`,
      () =>
        makeVocalLike({
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
        }),
      48000
    );
    return { a, b };
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

  /**
   * T3. Measured populations, cached by width — five tests below ask for
   * `ALIGN_SMOOTHING_MS` and the sweep asks for it a sixth time, and the answer
   * cannot differ between them: `alignEnvelopes` is pure over envelopes that
   * are themselves cached, so the six calls were six identical correlation
   * passes over the same arrays.
   *
   * Read-only by contract. Every consumer maps, filters or slices; none writes
   * to a member or to the arrays, and a test that started to would be handing
   * the next test a population that is no longer what its own name says.
   */
  const populationCache = new Map<number, Population>();
  afterAll(() => populationCache.clear());

  /** Every pair measured at one smoothing width. */
  function populationsAt(smoothingMs: number): Population {
    const cached = populationCache.get(smoothingMs);
    if (cached) return cached;
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
    const built: Population = {
      cover,
      unrelated: unrel,
      periodic: adversarialPeriodic(smoothingMs),
    };
    populationCache.set(smoothingMs, built);
    return built;
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
