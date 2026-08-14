/**
 * Task CP1 — constructed ground truth for the cover-journey alignment.
 *
 * The alignment stage has to answer two questions, and neither can be checked
 * against real audio: "where does this take sit against the original?" needs an
 * offset nobody knows for a recording made in a room, and "is this take even
 * the same song?" needs a NEGATIVE case that real fixtures cannot supply
 * (`cover-take.wav` and `cover-reference.wav` are related by construction).
 *
 * So the ground truth is BUILT. A schedule of syllables — start, duration,
 * pitch, amplitude — is drawn from a seeded PRNG, and two signals are rendered
 * from it:
 *
 *   - the SAME seed with different `leadSeconds` gives two recordings of one
 *     performance at a known offset (`leadSeconds` of the reference minus
 *     `leadSeconds` of the take, which is exactly the quantity the aligner
 *     reports);
 *   - the same seed with `hzScale`/`amplitudeJitter`/`noiseAmplitude` gives a
 *     DIFFERENT performance of the same phrasing — a cover, which is the case
 *     that actually ships;
 *   - a DIFFERENT seed gives audio with no relation at all, which is the case
 *     the confidence threshold exists to refuse.
 *
 * Everything here is deterministic: same options, same samples, on any machine.
 */

/** Mulberry32 — 32-bit, deterministic, and already the repo's idiom for a
 * seeded stream in a fixture (see `remixGoldenCases`). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface Syllable {
  /** Seconds from the first syllable's nominal zero, BEFORE `leadSeconds`. */
  startSeconds: number;
  durationSeconds: number;
  hz: number;
  amplitude: number;
}

/**
 * A syllable schedule: bursts of 0.12–0.37 s separated by gaps of 0.04–0.39 s,
 * which is roughly how sung phrasing sits on an onset envelope. The SCHEDULE is
 * what alignment keys on — two renderings of one schedule line up, two
 * schedules from different seeds do not.
 */
export function syllableSchedule(
  seed: number,
  seconds: number,
  minSyllables = 0,
  /**
   * CC2. When set, ONE period of this length is drawn and then tiled to fill
   * `seconds` — a song with a repeated chorus. The calibration population is
   * aperiodic by construction, so the regime where a rival lag one section away
   * is a GENUINE partial match had never been measured; it is the regime that
   * collapses prominence to ~0.01 while the peak stays at 0.8.
   */
  repeatPeriodSeconds = 0
): Syllable[] {
  if (repeatPeriodSeconds > 0) {
    const period = syllableSchedule(seed, repeatPeriodSeconds, minSyllables);
    const repeats = Math.max(1, Math.round(seconds / repeatPeriodSeconds));
    const tiled: Syllable[] = [];
    for (let r = 0; r < repeats; r++) {
      for (const syl of period) {
        tiled.push({ ...syl, startSeconds: syl.startSeconds + r * repeatPeriodSeconds });
      }
    }
    return tiled;
  }
  const rng = mulberry32(seed);
  const out: Syllable[] = [];
  let t = 0.2 + rng() * 0.3;
  while (t < seconds - 0.5) {
    const durationSeconds = 0.12 + rng() * 0.25;
    out.push({
      startSeconds: t,
      durationSeconds,
      hz: 140 + rng() * 180,
      amplitude: 0.3 + rng() * 0.6,
    });
    t += durationSeconds + 0.04 + rng() * 0.35;
  }
  // CP1 fix-round: a short window draws ZERO syllables from the loop above, and
  // a fixture that is silent by accident tests the silence path rather than the
  // one it was written for — which is exactly how the min-overlap gate came to
  // be covered by nothing. `minSyllables` packs a short window densely instead,
  // so "short" and "silent" stop being the same fixture.
  if (out.length < minSyllables) {
    out.length = 0;
    const slot = seconds / minSyllables;
    for (let i = 0; i < minSyllables; i++) {
      out.push({
        startSeconds: i * slot,
        durationSeconds: Math.min(0.12, slot * 0.6),
        hz: 140 + rng() * 180,
        amplitude: 0.3 + rng() * 0.6,
      });
    }
  }
  return out;
}

export interface SchedulePerturbation {
  /**
   * CC2. 1 = the take keeps the reference's tempo. Anything else scales every
   * START time, so the error a rigid global lag makes GROWS with time — which is
   * exactly what a singer drifting against a click does, and exactly what a
   * single-lag model cannot express. Durations are deliberately left alone: the
   * onset envelope keys on where a syllable STARTS.
   */
  tempoScale?: number;
  /**
   * CC2. Per-syllable start-time jitter, in seconds: each start is moved by an
   * independent uniform draw in ±this. The shipped floors were calibrated with
   * this at zero — the take shared the reference's onsets TO THE SAMPLE — and a
   * real cover does not. ±40 ms (SD 23 ms) is the measured band where the
   * un-smoothed evidence collapses while the recovered offset stays correct.
   */
  timingJitterSeconds?: number;
  /** Stream for the timing jitter, separate from `varianceSeed` so timing and
   * dynamics can be varied independently — and so that leaving the timing knobs
   * alone renders bit-identically to the pre-CC2 fixture. */
  timingSeed?: number;
}

/**
 * CC2. Applies the timing knobs to a drawn schedule: tempo first (a drift the
 * whole performance carries), then per-syllable jitter (the variance one
 * performance has against another). Pure — the input schedule is not mutated.
 */
export function perturbSchedule(
  schedule: Syllable[],
  opts: SchedulePerturbation
): Syllable[] {
  const { tempoScale = 1, timingJitterSeconds = 0, timingSeed = 104729 } = opts;
  if (tempoScale === 1 && timingJitterSeconds === 0) return schedule.map((s) => ({ ...s }));
  const rng = mulberry32(timingSeed);
  return schedule.map((syl) => {
    const drifted = syl.startSeconds * tempoScale;
    const jitter = timingJitterSeconds === 0 ? 0 : timingJitterSeconds * (rng() * 2 - 1);
    return { ...syl, startSeconds: Math.max(0, drifted + jitter) };
  });
}

export interface VocalLikeOptions extends SchedulePerturbation {
  seed: number;
  sampleRate: number;
  /** Length of the SCHEDULE, before `leadSeconds` is added in front of it. */
  seconds: number;
  /** Silence before the first syllable. The difference between the reference's
   * and the take's is the ground-truth offset. */
  leadSeconds?: number;
  /** 1 = the same notes. A cover sings the same words at other pitches. */
  hzScale?: number;
  /** 0 = the same dynamics. A cover does not hit the same levels. */
  amplitudeJitter?: number;
  /** Broadband noise, as a peak amplitude. */
  noiseAmplitude?: number;
  /** Stream for the jitter/noise, so a "different performance" can be varied
   * without disturbing the schedule the two share. */
  varianceSeed?: number;
  channels?: number;
  /** Forces at least this many syllables into a window too short to draw them
   * naturally — see `syllableSchedule`. */
  minSyllables?: number;
  /** CC2. Draw one period of this length and tile it — a repeated chorus. See
   * `syllableSchedule`. */
  repeatPeriodSeconds?: number;
}

/**
 * Renders a schedule as vocal-like audio: each syllable is a raised-cosine
 * amplitude envelope over a three-harmonic tone. Nothing here is a claim about
 * how singing sounds — it is a claim about where the ATTACKS are, which is the
 * only thing an onset envelope carries.
 */
export function makeVocalLike(opts: VocalLikeOptions): Float32Array[] {
  const {
    seed,
    sampleRate,
    seconds,
    leadSeconds = 0,
    hzScale = 1,
    amplitudeJitter = 0,
    noiseAmplitude = 0,
    varianceSeed = seed + 1,
    channels = 1,
    minSyllables = 0,
    repeatPeriodSeconds = 0,
    tempoScale = 1,
    timingJitterSeconds = 0,
    timingSeed = varianceSeed + 104729,
  } = opts;

  const schedule = perturbSchedule(
    syllableSchedule(seed, seconds, minSyllables, repeatPeriodSeconds),
    { tempoScale, timingJitterSeconds, timingSeed }
  );
  const total = Math.round((seconds + leadSeconds) * sampleRate);
  const mono = new Float32Array(total);
  const rng = mulberry32(varianceSeed);

  for (const syl of schedule) {
    const gain = syl.amplitude * (1 + amplitudeJitter * (rng() * 2 - 1));
    const hz = syl.hz * hzScale;
    const start = Math.round((leadSeconds + syl.startSeconds) * sampleRate);
    const len = Math.round(syl.durationSeconds * sampleRate);
    for (let i = 0; i < len; i++) {
      const idx = start + i;
      if (idx < 0 || idx >= total) continue;
      // Raised cosine: silence at both edges, so every syllable is an attack
      // followed by a decay rather than a click.
      const env = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / len);
      const t = i / sampleRate;
      const w = 2 * Math.PI * hz * t;
      mono[idx] += gain * env * (Math.sin(w) + 0.5 * Math.sin(2 * w) + 0.25 * Math.sin(3 * w)) * 0.55;
    }
  }

  if (noiseAmplitude > 0) {
    for (let i = 0; i < total; i++) mono[i] += noiseAmplitude * (rng() * 2 - 1);
  }

  const out: Float32Array[] = [mono];
  for (let c = 1; c < channels; c++) out.push(Float32Array.from(mono));
  return out;
}

/**
 * V3. What a separated stem's ATTACKS look like next to the mix's: later, and
 * softer.
 *
 * The signal's amplitude envelope is made to rise over `tauMs` instead of
 * instantly, and the waveform is re-gained to follow it — so the spectrum is
 * untouched and only the TIMING of the energy moves. That distinction is the
 * whole point: a naive lowpass of the samples was tried first and it destroys a
 * vocal outright (measured: alignment errors of 8–10 SECONDS), which tests
 * nothing about a refinement.
 *
 * ── What this is a model OF, and what it is not ─────────────────────────────
 * It is a model of mask-induced transient spreading: a mask estimated on an
 * analysis grid cannot open faster than its own window, so a note's attack
 * arrives spread over that window rather than at the sample it really began.
 * It is NOT a measurement of this repo's separator, and no claim is made here
 * about how large `tauMs` is for htdemucs on real music.
 *
 * What the tests built on it prove is therefore conditional and stated that
 * way: WHEN the stem's onsets are displaced from the song's, refining against
 * the song recovers the displacement; when they are not, the refinement does not
 * move a right answer. Both halves are asserted, because only the pair of them
 * is a reason to ship a refinement.
 *
 * Causal on purpose. Real separation also produces pre-echo, which would
 * displace onsets EARLY; smearing one way only makes the displacement a signed
 * quantity a test can point at, rather than a symmetric blur that averages to
 * nothing and proves neither direction.
 */
export function smearAttacks(x: Float32Array, sampleRate: number, tauMs: number): Float32Array {
  if (!(tauMs > 0)) return Float32Array.from(x);
  // A 2 ms follower is fast enough to track a real attack, so what the slow
  // stage below smears is the attack rather than the follower's own lag.
  const fast = 1 - Math.exp(-1 / (0.002 * sampleRate));
  const slow = 1 - Math.exp(-1 / ((tauMs / 1000) * sampleRate));
  const out = new Float32Array(x.length);
  let env = 0;
  let smeared = 0;
  for (let i = 0; i < x.length; i++) {
    env += (Math.abs(x[i]) - env) * fast;
    smeared += (env - smeared) * slow;
    // The epsilon keeps silence silent rather than dividing 0 by 0; it is far
    // below anything the onset envelope's own std floor would keep.
    out[i] = x[i] * (smeared / (env + 1e-6));
  }
  return out;
}
