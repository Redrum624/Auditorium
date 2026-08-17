import { deEsserEffect, sibilanceReductionDb } from './DeEsserEffect';
import { envelopeFollower, maxAcrossChannels } from './envelope';
import { designBiquad, processBiquad } from '../../dsp/biquad';
import { getAllEffects } from '../EffectRegistry';
import { registerAllEffects } from '../registerAll';
import type { EffectParamValue } from '../types';

const SR = 48000; // the rate the defaults were measured at

function snapshot(channels: Float32Array[]): number[][] {
  return channels.map((c) => Array.from(c));
}

function run(
  channels: Float32Array[],
  params: Record<string, EffectParamValue> = {},
  onProgress?: (fraction: number) => void
): Float32Array[] {
  const before = snapshot(channels);
  const result = deEsserEffect.process(channels, SR, params, onProgress);
  channels.forEach((c, i) => expect(Array.from(c)).toEqual(before[i]));
  return result.channels;
}

/** Deterministic PRNG so the sibilance fixture is reproducible. */
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function rms(signal: Float32Array, start = 0, end = signal.length): number {
  let sum = 0;
  for (let i = start; i < end; i++) sum += signal[i] * signal[i];
  return end > start ? Math.sqrt(sum / (end - start)) : 0;
}

function scaleToRms(signal: Float32Array, targetRms: number): Float32Array {
  const current = rms(signal);
  const k = current > 0 ? targetRms / current : 0;
  const out = new Float32Array(signal.length);
  for (let i = 0; i < signal.length; i++) out[i] = signal[i] * k;
  return out;
}

function dbToLin(db: number): number {
  return Math.pow(10, db / 20);
}

function gainDb(input: Float32Array, output: Float32Array, start: number, end: number): number {
  return 20 * Math.log10(rms(output, start, end) / rms(input, start, end));
}

/** Band-limited noise, 5-12 kHz: a synthetic "sss". */
function sibilance(seconds: number, targetRmsDb: number, seed = 1): Float32Array {
  const n = Math.round(seconds * SR);
  const noise = new Float32Array(n);
  const rand = mulberry32(seed);
  for (let i = 0; i < n; i++) noise[i] = rand() * 2 - 1;
  const hp = designBiquad('highpass', SR, 5000, Math.SQRT1_2);
  const lp = designBiquad('lowpass', SR, 12000, Math.SQRT1_2);
  let band = processBiquad(processBiquad(noise, hp), hp);
  band = processBiquad(processBiquad(band, lp), lp);
  return scaleToRms(band, dbToLin(targetRmsDb));
}

/**
 * A sustained vowel: harmonics of 200 Hz out to 5 kHz falling at 6 dB/oct.
 * Deliberately harsher than a real glottal source (-12 dB/oct), so the fixture
 * carries real energy right up to the crossover instead of being a strawman
 * that stops at the formants.
 */
function vowel(seconds: number, targetRmsDb: number): Float32Array {
  const n = Math.round(seconds * SR);
  const out = new Float32Array(n);
  for (let h = 1; h * 200 <= 5000; h++) {
    const freq = h * 200;
    const amp = 1 / h;
    for (let i = 0; i < n; i++) out[i] += amp * Math.sin((2 * Math.PI * freq * i) / SR);
  }
  return scaleToRms(out, dbToLin(targetRmsDb));
}

/** Linear fade to zero across the whole signal. */
function fadeOut(signal: Float32Array): Float32Array {
  const out = new Float32Array(signal.length);
  for (let i = 0; i < signal.length; i++) out[i] = signal[i] * (1 - i / signal.length);
  return out;
}

/**
 * Sibilance faded to nothing, followed by an equal stretch of DIGITAL SILENCE.
 * The silent tail is what makes the Nyquist boundary testable. At exactly
 * Nyquist the one-pole design lands on a NEAR pole-zero cancellation (b0 = b1 =
 * 0.9999999999999999 against a1 = 0.9999999999999998, off by ~2e-13) feeding a
 * marginally stable recursion, so the split band carries a ~2e-15 residue that
 * never decays. Against signal it is swamped and the guard looks equivalent to
 * no guard; against exact zeros it is the entire output.
 */
function fadedWithSilentTail(seconds: number, seed: number): Float32Array {
  return concat(fadeOut(sibilance(seconds, -12, seed)), new Float32Array(Math.round(seconds * SR)));
}

function concat(...parts: Float32Array[]): Float32Array {
  const total = parts.reduce((a, p) => a + p.length, 0);
  const out = new Float32Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

/** Peak sidechain level the effect will see, computed from the same public
 * primitives it uses — this is how a fixture is placed exactly ON the
 * threshold boundary rather than near it. */
function peakSidechainDb(
  channels: Float32Array[],
  freqHz: number,
  attackMs: number,
  releaseMs: number
): number {
  const coeffs = designBiquad('highpass', SR, freqHz, Math.SQRT1_2);
  const band = channels.map((c) => processBiquad(processBiquad(c, coeffs), coeffs));
  const env = envelopeFollower(maxAcrossChannels(band), SR, attackMs, releaseMs);
  let peak = 0;
  for (let i = 0; i < env.length; i++) if (env[i] > peak) peak = env[i];
  return 20 * Math.log10(Math.max(peak, 1e-6));
}

const DEFAULTS = { freqHz: 5500, thresholdDb: -30, ratio: 4, attackMs: 1, releaseMs: 30 };

describe('sibilanceReductionDb', () => {
  it('is zero below AND exactly at the threshold, positive above it', () => {
    expect(sibilanceReductionDb(-1, 4)).toBe(0);
    expect(sibilanceReductionDb(-1e-9, 4)).toBe(0);
    expect(sibilanceReductionDb(0, 4)).toBe(0); // ON the boundary: still a no-op
    expect(sibilanceReductionDb(1e-9, 4)).toBeGreaterThan(0);
    expect(sibilanceReductionDb(1, 4)).toBeCloseTo(0.75, 12);
  });

  it('applies the (1 - 1/ratio) slope, and ratio 1 is a no-op at any level', () => {
    expect(sibilanceReductionDb(8, 1)).toBe(0);
    expect(sibilanceReductionDb(8, 2)).toBeCloseTo(4, 12);
    expect(sibilanceReductionDb(8, 4)).toBeCloseTo(6, 12);
    expect(sibilanceReductionDb(8, 20)).toBeCloseTo(7.6, 12);
    // Reduction grows with how far over the threshold the detector sits.
    expect(sibilanceReductionDb(16, 4)).toBeCloseTo(12, 12);
  });
});

describe('de-esser registration and parameters', () => {
  it('registers as de-esser in category Dynamics', () => {
    registerAllEffects();
    expect(deEsserEffect.id).toBe('de-esser');
    expect(deEsserEffect.category).toBe('Dynamics');
    expect(getAllEffects().map((e) => e.id)).toContain('de-esser');
  });

  it('exposes frequency, threshold, ratio, attack, release and a boolean listen switch', () => {
    const byId = new Map(deEsserEffect.params.map((p) => [p.id, p]));
    expect([...byId.keys()].sort()).toEqual(
      ['attackMs', 'freqHz', 'listen', 'ratio', 'releaseMs', 'thresholdDb'].sort()
    );
    expect(byId.get('listen')?.type).toBe('boolean');
    expect(byId.get('listen')?.default).toBe(false);
    // Defaults are measured values (see the file header) - changing one means
    // redoing the measurement, not rounding to a nicer number.
    expect(byId.get('freqHz')?.default).toBe(DEFAULTS.freqHz);
    expect(byId.get('thresholdDb')?.default).toBe(DEFAULTS.thresholdDb);
    expect(byId.get('ratio')?.default).toBe(DEFAULTS.ratio);
    expect(byId.get('attackMs')?.default).toBe(DEFAULTS.attackMs);
    expect(byId.get('releaseMs')?.default).toBe(DEFAULTS.releaseMs);
    // The range brackets the measured optimum and the measured sibilant peak.
    expect(byId.get('freqHz')?.min).toBeLessThanOrEqual(2000);
    expect(byId.get('freqHz')?.max).toBeGreaterThanOrEqual(11000);
  });
});

describe('de-esser zero-reduction identity', () => {
  it('is bit-identical to the input, on every sample of every channel, when nothing crosses the threshold', () => {
    const left = concat(vowel(0.1, -12), sibilance(0.1, -12, 3));
    const right = concat(sibilance(0.1, -12, 7), vowel(0.1, -12));
    const input = [left, right];
    // Threshold at 0 dBFS: the sidechain envelope of a -12 dBFS signal cannot
    // reach it, so the reduction is exactly 0 and the gain exactly 1.
    const out = run(input, { ...DEFAULTS, thresholdDb: 0 });
    expect(out).toHaveLength(2);
    expect(Array.from(out[0])).toEqual(Array.from(left));
    expect(Array.from(out[1])).toEqual(Array.from(right));
  });

  it('is bit-identical at ratio 1 even with the threshold far below the signal', () => {
    const input = [sibilance(0.2, -12, 11)];
    const out = run(input, { ...DEFAULTS, thresholdDb: -60, ratio: 1 });
    expect(Array.from(out[0])).toEqual(Array.from(input[0]));
  });

  it('preserves -0 samples, which the arithmetic path alone would flip to +0', () => {
    const input = [Float32Array.from([-0, 0, -0.5, 0.5, -0])];
    const out = run(input, { ...DEFAULTS, thresholdDb: 0 });
    expect(Object.is(out[0][0], -0)).toBe(true);
    expect(Object.is(out[0][1], 0)).toBe(true);
    expect(Object.is(out[0][4], -0)).toBe(true);
  });

  it('emits exact silence in listen mode when nothing is being removed', () => {
    const input = [vowel(0.15, -12)];
    const out = run(input, { ...DEFAULTS, thresholdDb: 0, listen: true });
    expect(Array.from(out[0])).toEqual(new Array(input[0].length).fill(0));
  });
});

describe('de-esser threshold boundary', () => {
  const input = [sibilance(0.3, -12, 5)];
  const peakDb = peakSidechainDb(input, DEFAULTS.freqHz, DEFAULTS.attackMs, DEFAULTS.releaseMs);

  it('leaves the signal untouched with the threshold ABOVE the peak detector level', () => {
    const out = run(input, { ...DEFAULTS, thresholdDb: peakDb + 0.5 });
    expect(Array.from(out[0])).toEqual(Array.from(input[0]));
  });

  it('leaves the signal untouched with the threshold exactly ON the peak detector level', () => {
    // At the peak sample overDb is exactly 0 - the equality case of the
    // comparison, and a no-op.
    const out = run(input, { ...DEFAULTS, thresholdDb: peakDb });
    expect(Array.from(out[0])).toEqual(Array.from(input[0]));
  });

  it('reduces as soon as the threshold drops BELOW the peak detector level', () => {
    // Half a dB past the boundary is enough to move the output: the fixture is
    // sized so the boundary is what decides, not the tolerance.
    const out = run(input, { ...DEFAULTS, thresholdDb: peakDb - 0.5 });
    expect(Array.from(out[0])).not.toEqual(Array.from(input[0]));
    expect(gainDb(input[0], out[0], 0, input[0].length)).toBeLessThan(0);
  });

  it('reduces harder the further below the peak the threshold sits', () => {
    const shallow = run(input, { ...DEFAULTS, thresholdDb: peakDb - 6 });
    const deep = run(input, { ...DEFAULTS, thresholdDb: peakDb - 18 });
    const shallowDb = gainDb(input[0], shallow[0], 0, input[0].length);
    const deepDb = gainDb(input[0], deep[0], 0, input[0].length);
    expect(shallowDb).toBeLessThan(-1);
    expect(deepDb).toBeLessThan(shallowDb - 4);
  });
});

describe('de-esser selectivity (the test that matters)', () => {
  // Vowel, sibilant, vowel - all three at the SAME RMS, so any difference in
  // treatment comes from spectrum, not level.
  const LEVEL_DB = -12;
  const VOWEL_SEC = 0.4;
  const SIB_SEC = 0.15;
  const vowelA = vowel(VOWEL_SEC, LEVEL_DB);
  const sib = sibilance(SIB_SEC, LEVEL_DB, 21);
  const vowelB = vowel(VOWEL_SEC, LEVEL_DB);
  const signal = concat(vowelA, sib, vowelB);
  const sibStart = vowelA.length;
  const sibEnd = sibStart + sib.length;

  it('attenuates the sibilant and leaves the vowel at the same level completely alone', () => {
    const out = run([signal], DEFAULTS);

    // Does something: the sibilant burst is pulled down. Measured from 5 ms in,
    // past the attack. It comes out at -11.2 dB; the -6 dB bound is placed
    // deliberately between that and the -5.1 dB a single split section manages,
    // so dropping a section of the split shows up here as a failure.
    const sibDb = gainDb(signal, out[0], sibStart + Math.round(0.005 * SR), sibEnd);
    expect(sibDb).toBeLessThan(-6);

    // Does the RIGHT thing: the vowel ahead of it is not attenuated at all -
    // not "a bit less", but bit-identical over its whole extent, because the
    // detector never crossed the threshold and the gain stayed exactly 1.
    expect(Array.from(out[0].subarray(0, sibStart))).toEqual(Array.from(vowelA));

    // And the vowel after it, once the release has run out (5 x 30 ms).
    const tailStart = sibEnd + Math.round(0.15 * SR);
    expect(Array.from(out[0].subarray(tailStart, signal.length))).toEqual(
      Array.from(vowelB.subarray(tailStart - sibEnd, vowelB.length))
    );
  });

  it('separates the two by more than 6 dB even with the vowel scanned in windows', () => {
    const out = run([signal], DEFAULTS);
    const sibDb = gainDb(signal, out[0], sibStart + Math.round(0.005 * SR), sibEnd);
    // Scan the whole vowel, not just its first window: a loop pinned on one
    // point pins the point, not the extent.
    const win = Math.round(0.02 * SR);
    let worstVowelDb = 0;
    let windows = 0;
    for (let start = 0; start + win <= sibStart; start += win) {
      worstVowelDb = Math.min(worstVowelDb, gainDb(signal, out[0], start, start + win));
      windows++;
    }
    // Without this the scan could cover no windows at all and `toBe(0)` would
    // pass on the initialiser.
    expect(windows).toBe(Math.floor(sibStart / win));
    expect(windows).toBeGreaterThan(15);
    expect(worstVowelDb).toBe(0);
    expect(sibDb).toBeLessThan(worstVowelDb - 6);
  });

  it('does not simply low-pass: the sibilant keeps its low band while its high band is cut', () => {
    const out = run([signal], DEFAULTS);
    const lp = designBiquad('lowpass', SR, 1000, Math.SQRT1_2);
    const hp = designBiquad('highpass', SR, 8000, Math.SQRT1_2);
    const inLow = processBiquad(signal, lp);
    const outLow = processBiquad(out[0], lp);
    const inHigh = processBiquad(signal, hp);
    const outHigh = processBiquad(out[0], hp);
    const from = sibStart + Math.round(0.005 * SR);
    // Everything below 1 kHz survives the whole file (the vowels are there and
    // are untouched); the >8 kHz content of the burst is what goes.
    expect(gainDb(inLow, outLow, 0, signal.length)).toBeGreaterThan(-0.5);
    expect(gainDb(inHigh, outHigh, from, sibEnd)).toBeLessThan(-8);
  });
});

describe('de-esser recombination never boosts', () => {
  it('holds every band at or below its input level even when driven to the limit', () => {
    // The two-section residual bumps +0.97 dB at the corner; the recombined
    // response must still not lift anything. Probed across the corner, at it,
    // and either side of it.
    for (const freq of [1000, 3000, 5500, 8000, 15000]) {
      const n = Math.round(0.3 * SR);
      const tone = new Float32Array(n);
      for (let i = 0; i < n; i++) tone[i] = 0.5 * Math.sin((2 * Math.PI * freq * i) / SR);
      const out = run([tone], { ...DEFAULTS, thresholdDb: -60, ratio: 20 });
      const from = Math.round(0.1 * SR);
      expect(gainDb(tone, out[0], from, n)).toBeLessThanOrEqual(0.001);
    }
  });
});

describe('de-esser listen path', () => {
  const LEVEL_DB = -12;
  const vowelA = vowel(0.3, LEVEL_DB);
  const vowelUnder = vowel(0.15, LEVEL_DB);
  const sib = sibilance(0.15, LEVEL_DB, 33);
  // The burst sits ON TOP of the vowel, the way a voiced sibilant does, so the
  // listen path is asked to isolate the removed band while low-frequency
  // content is present - not just while the signal happens to be all sibilance.
  const mixed = new Float32Array(sib.length);
  for (let i = 0; i < sib.length; i++) mixed[i] = vowelUnder[i] + sib[i];
  const signal = concat(vowelA, mixed);
  const sibStart = vowelA.length;

  it('returns exactly what the processed path removed, sample by sample', () => {
    const processed = run([signal], DEFAULTS);
    const removed = run([signal], { ...DEFAULTS, listen: true });
    for (let i = 0; i < signal.length; i++) {
      expect(processed[0][i] + removed[0][i]).toBeCloseTo(signal[i], 6);
    }
  });

  it('is not the processed signal: silent where nothing is removed, loud where it is', () => {
    const processed = run([signal], DEFAULTS);
    const removed = run([signal], { ...DEFAULTS, listen: true });

    // Over the vowel the processed path carries the full signal and the listen
    // path carries nothing at all.
    expect(rms(processed[0], 0, sibStart)).toBeCloseTo(rms(vowelA), 6);
    expect(rms(removed[0], 0, sibStart)).toBe(0);

    // Over the burst the listen path is substantial - within 6 dB of what the
    // processed path kept - and is not a copy of it.
    const removedDb = 20 * Math.log10(rms(removed[0], sibStart, signal.length));
    const processedDb = 20 * Math.log10(rms(processed[0], sibStart, signal.length));
    expect(removedDb).toBeGreaterThan(processedDb - 6);
    expect(Array.from(removed[0].subarray(sibStart))).not.toEqual(
      Array.from(processed[0].subarray(sibStart))
    );
  });

  it('reconstructs the input on BOTH channels of a stereo pair', () => {
    const other = concat(vowel(0.3, LEVEL_DB), sibilance(0.15, -18, 37));
    const stereo = [signal, other];
    const processed = run(stereo, DEFAULTS);
    const removed = run(stereo, { ...DEFAULTS, listen: true });
    for (let ch = 0; ch < 2; ch++) {
      let removedEnergy = 0;
      for (let i = 0; i < stereo[ch].length; i++) {
        expect(processed[ch][i] + removed[ch][i]).toBeCloseTo(stereo[ch][i], 6);
        removedEnergy += removed[ch][i] * removed[ch][i];
      }
      // Both channels genuinely had something taken out of them - a channel
      // left as all zeros would satisfy the reconstruction above vacuously
      // only if it were also untouched, so pin that it was not.
      expect(removedEnergy).toBeGreaterThan(0);
    }
  });

  it('carries the high band, not the programme: almost none of it is below 1 kHz', () => {
    const removed = run([signal], { ...DEFAULTS, listen: true });
    const lp = designBiquad('lowpass', SR, 1000, Math.SQRT1_2);
    const belowCrossover = processBiquad(removed[0], lp);
    // 0.105 as built - the residual of a 12 dB/oct subtractive split still
    // reaches down a little, and the vowel under the burst is what shows up
    // there. Handing back the PROCESSED signal instead puts ~0.9 here, since
    // the programme is mostly low-frequency, so the bound sits between them.
    expect(rms(belowCrossover) / rms(removed[0])).toBeLessThan(0.2);
  });
});

describe('de-esser channel handling', () => {
  // Run it both ways round: a detector that only ever looks at channel 0 still
  // passes the L-loud case, so the R-loud case is the one that pins the link.
  it.each([
    ['L', 0, 1],
    ['R', 1, 0],
  ])('links the gain across channels: sibilance in %s pulls the other down, over the whole burst', (_label, loudCh, quietCh) => {
    const vowelPart = vowel(0.2, -12);
    const loud = concat(vowelPart, sibilance(0.15, -12, 41));
    // The other channel carries sibilance 28 dB quieter - far too quiet to
    // trigger on its own.
    const quiet = concat(vowelPart, sibilance(0.15, -40, 43));
    const input: Float32Array[] = [];
    input[loudCh] = loud;
    input[quietCh] = quiet;
    const sibStart = vowelPart.length;
    const from = sibStart + Math.round(0.005 * SR);

    // Control: on its own, the quiet channel is below the threshold and comes
    // back untouched.
    expect(Array.from(run([quiet], DEFAULTS)[0])).toEqual(Array.from(quiet));

    const out = run(input, DEFAULTS);
    expect(gainDb(loud, out[loudCh], from, loud.length)).toBeLessThan(-6);
    // Linked, the same quiet burst is now ducked - and across the whole burst,
    // not just at its start.
    const win = Math.round(0.02 * SR);
    let windows = 0;
    for (let start = from; start + win <= quiet.length; start += win) {
      const loudDb = gainDb(loud, out[loudCh], start, start + win);
      const quietDb = gainDb(quiet, out[quietCh], start, start + win);
      expect(quietDb).toBeLessThan(-4);
      // Linked, not merely silenced. Both bursts have the same spectrum, so
      // the same gain must produce the same dB change in both. Without this,
      // a channel loop that stopped after channel 0 would leave zeros here and
      // read as -Infinity, i.e. "very ducked", and pass.
      expect(Math.abs(quietDb - loudDb)).toBeLessThan(1);
      windows++;
    }
    expect(windows).toBeGreaterThan(5);
    // Both channels come back untouched before the burst.
    expect(Array.from(out[0].subarray(0, sibStart))).toEqual(Array.from(vowelPart));
    expect(Array.from(out[1].subarray(0, sibStart))).toEqual(Array.from(vowelPart));
  });

  it('handles mono, and preserves channel count and length', () => {
    const mono = [concat(vowel(0.1, -12), sibilance(0.1, -12, 51))];
    const out = run(mono, DEFAULTS);
    expect(out).toHaveLength(1);
    expect(out[0].length).toBe(mono[0].length);
    out[0].forEach((v) => expect(Number.isFinite(v)).toBe(true));
  });

  it('handles an empty channel list and zero-length channels', () => {
    expect(deEsserEffect.process([], SR, DEFAULTS).channels).toEqual([]);
    const empty = deEsserEffect.process([new Float32Array(0)], SR, DEFAULTS).channels;
    expect(empty).toHaveLength(1);
    expect(empty[0].length).toBe(0);
  });
});

describe('de-esser crossover frequency bounds', () => {
  const input = [fadedWithSilentTail(0.1, 61)];
  const nyquist = SR / 2;
  const params = { ...DEFAULTS, thresholdDb: -60 };

  it('processes at a crossover inside the band', () => {
    const out = run(input, { ...params, freqHz: 12000 });
    expect(Array.from(out[0])).not.toEqual(Array.from(input[0]));
  });

  it('passes through exactly ON Nyquist and above it rather than designing a degenerate filter', () => {
    // The detector floor is -120 dBFS, so a threshold below it puts EVERY
    // sample on the reduction path, where the split filter's output is what
    // reaches the ear. Past Nyquist both filters are outright unstable; AT
    // Nyquist the split lands on a near pole-zero cancellation whose residue
    // the fixture's silent tail exposes. Spelling the guard `> nyquist`
    // instead of `>= nyquist` changes all 4800 samples of that tail.
    for (const freqHz of [nyquist, nyquist + 1, SR]) {
      const out = run(input, { ...params, thresholdDb: -140, freqHz });
      expect(out[0]).not.toBe(input[0]);
      expect(Array.from(out[0])).toEqual(Array.from(input[0]));
    }
  });

  it('passes both channels through, and silences both under listen, when out of band', () => {
    const stereo = [input[0], fadedWithSilentTail(0.1, 63)];
    const passed = run(stereo, { ...params, thresholdDb: -140, freqHz: nyquist });
    expect(Array.from(passed[0])).toEqual(Array.from(stereo[0]));
    expect(Array.from(passed[1])).toEqual(Array.from(stereo[1]));
    const silent = run(stereo, { ...params, freqHz: nyquist, listen: true });
    expect(Array.from(silent[0])).toEqual(new Array(stereo[0].length).fill(0));
    expect(Array.from(silent[1])).toEqual(new Array(stereo[1].length).fill(0));
  });

  it('passes through at and below a zero (or NaN) crossover, and processes just above it', () => {
    for (const freqHz of [0, -1, NaN]) {
      expect(Array.from(run(input, { ...params, freqHz })[0])).toEqual(Array.from(input[0]));
    }
    expect(Array.from(run(input, { ...params, freqHz: 1 })[0])).not.toEqual(Array.from(input[0]));
  });

  it('emits silence rather than a copy when listening past Nyquist', () => {
    const out = run(input, { ...params, freqHz: nyquist, listen: true });
    expect(Array.from(out[0])).toEqual(new Array(input[0].length).fill(0));
  });
});

describe('de-esser progress reporting', () => {
  it('rises once through the whole job and reaches 1 exactly once, on the last sample', () => {
    // Long enough (and stereo) that several progress chunks fall inside the
    // run: 72000 samples x 2 channels against a 65536-sample chunk. A denominator
    // that counted one channel's samples instead of the whole job would report
    // 100 % at the end of channel 0 and then start over.
    const fractions: number[] = [];
    const stereo = [sibilance(1.5, -12, 71), sibilance(1.5, -12, 73)];
    run(stereo, DEFAULTS, (f) => fractions.push(f));

    expect(fractions.length).toBeGreaterThan(2);
    for (let i = 1; i < fractions.length; i++) {
      expect(fractions[i]).toBeGreaterThan(fractions[i - 1]);
    }
    expect(fractions.filter((f) => f === 1)).toHaveLength(1);
    expect(fractions[fractions.length - 1]).toBe(1);
    expect(fractions[0]).toBeLessThan(1);
  });
});
