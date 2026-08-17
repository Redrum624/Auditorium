import {
  partitionStems,
  ratioMaskBin,
  ratioMaskBinInto,
  spectralEnergyInto,
  colaWindowEnergy,
  DEFAULT_STEM_PARTITION_OPTIONS,
} from './stemPartition';
import { stft, istft } from './stft';

// ---------------------------------------------------------------------------
// Deterministic PRNG (no reliance on Math.random) so fixtures are reproducible.
// ---------------------------------------------------------------------------
function makeRand(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    // xorshift32
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 0xffffffff - 0.5; // [-0.5, 0.5)
  };
}

/** Naive one-pole low/high split of a signal into two band estimates. */
function bandSplit(x: Float32Array): [Float32Array, Float32Array] {
  const lp = new Float32Array(x.length);
  const hp = new Float32Array(x.length);
  const a = 0.85; // one-pole smoothing coefficient
  let y = 0;
  for (let n = 0; n < x.length; n++) {
    y = a * y + (1 - a) * x[n];
    lp[n] = y;
    hp[n] = x[n] - y;
  }
  return [lp, hp];
}

function scale(x: Float32Array, k: number): Float32Array {
  const out = new Float32Array(x.length);
  for (let i = 0; i < x.length; i++) out[i] = x[i] * k;
  return out;
}

function zeros(len: number): Float32Array {
  return new Float32Array(len);
}

interface Fixture {
  name: string;
  rate: number;
  mix: Float32Array[]; // [channel][sample]
  estimates: Float32Array[][]; // [source][channel][sample]
}

/** Build a per-source estimate set from a per-channel band split. */
function estimatesFromBands(mix: Float32Array[], nSources = 4): Float32Array[][] {
  const channels = mix.length;
  const est: Float32Array[][] = [];
  for (let s = 0; s < nSources; s++) est.push(new Array(channels));
  for (let c = 0; c < channels; c++) {
    const [lp, hp] = bandSplit(mix[c]);
    // Route bands into sources; extra sources get silence.
    est[0][c] = lp;
    if (nSources > 1) est[1][c] = hp;
    for (let s = 2; s < nSources; s++) est[s][c] = zeros(mix[c].length);
  }
  return est;
}

function tone(len: number, rate: number, freq: number, amp = 0.7): Float32Array {
  const x = new Float32Array(len);
  for (let n = 0; n < len; n++) x[n] = amp * Math.sin((2 * Math.PI * freq * n) / rate);
  return x;
}

function buildFixtures(): Fixture[] {
  const fx: Fixture[] = [];

  // 1. Silence — mono, 44.1k.
  {
    const mix = [zeros(4096)];
    fx.push({ name: 'silence (mono, 44.1k)', rate: 44100, mix, estimates: estimatesFromBands(mix) });
  }

  // 2. DC — mono, 48k. Estimates split the DC between two sources.
  {
    const dc = new Float32Array(4096).fill(0.5);
    const mix = [dc];
    const est: Float32Array[][] = [
      [scale(dc, 0.6)],
      [scale(dc, 0.4)],
      [zeros(4096)],
      [zeros(4096)],
    ];
    fx.push({ name: 'DC (mono, 48k)', rate: 48000, mix, estimates: est });
  }

  // 3. Single tone — stereo, 44.1k, prime-ish length.
  {
    const len = 8009; // not a multiple of hop (256)
    const l = tone(len, 44100, 440);
    const r = tone(len, 44100, 441, 0.6);
    const mix = [l, r];
    fx.push({ name: 'single tone (stereo, 44.1k)', rate: 44100, mix, estimates: estimatesFromBands(mix) });
  }

  // 4. Multi-tone — stereo, 48k.
  {
    const len = 12000;
    const mk = (rate: number) => {
      const x = new Float32Array(len);
      for (let n = 0; n < len; n++) {
        x[n] =
          0.4 * Math.sin((2 * Math.PI * 220 * n) / rate) +
          0.3 * Math.sin((2 * Math.PI * 1000 * n) / rate) +
          0.2 * Math.sin((2 * Math.PI * 5000 * n) / rate);
      }
      return x;
    };
    const mix = [mk(48000), mk(48000)];
    fx.push({ name: 'multi-tone (stereo, 48k)', rate: 48000, mix, estimates: estimatesFromBands(mix) });
  }

  // 5. White noise — mono, 44.1k, prime length.
  {
    const len = 7919; // prime
    const rand = makeRand(1234567);
    const x = new Float32Array(len);
    for (let n = 0; n < len; n++) x[n] = rand();
    const mix = [x];
    fx.push({ name: 'white noise (mono, prime len, 44.1k)', rate: 44100, mix, estimates: estimatesFromBands(mix) });
  }

  // 6. Clipping-level (+-1.0) — mono, 48k. Hard square wave hits the rails.
  {
    const len = 5000;
    const x = new Float32Array(len);
    for (let n = 0; n < len; n++) x[n] = Math.sin((2 * Math.PI * 300 * n) / 48000) >= 0 ? 1.0 : -1.0;
    const mix = [x];
    fx.push({ name: 'clipping +-1.0 square (mono, 48k)', rate: 48000, mix, estimates: estimatesFromBands(mix) });
  }

  // 7. Very short (< one window) — mono, 44.1k, len 300 < fftSize 1024.
  {
    const len = 300;
    const x = tone(len, 44100, 500);
    const mix = [x];
    const est: Float32Array[][] = [[x.slice()], [zeros(len)], [zeros(len)], [zeros(len)]];
    fx.push({ name: 'very short (<1 window, mono, 44.1k)', rate: 44100, mix, estimates: est });
  }

  // 8. Mix routed entirely to one source (mask ~ 1) — stereo, 48k.
  {
    const len = 6000;
    const l = tone(len, 48000, 330);
    const r = tone(len, 48000, 660, 0.5);
    const mix = [l, r];
    const est: Float32Array[][] = [
      [l.slice(), r.slice()],
      [zeros(len), zeros(len)],
      [zeros(len), zeros(len)],
      [zeros(len), zeros(len)],
    ];
    fx.push({ name: 'mix-as-single-source (stereo, 48k)', rate: 48000, mix, estimates: est });
  }

  // 9. All-zero estimates -> everything routes to residual — mono, 44.1k.
  {
    const len = 4096;
    const rand = makeRand(99);
    const x = new Float32Array(len);
    for (let n = 0; n < len; n++) x[n] = rand();
    const mix = [x];
    const est: Float32Array[][] = [[zeros(len)], [zeros(len)], [zeros(len)], [zeros(len)]];
    fx.push({ name: 'all-zero estimates (mono, 44.1k)', rate: 44100, mix, estimates: est });
  }

  // 10. Odd length exactly hop+1 — boundary around a single frame, 48k stereo.
  {
    const len = 257; // hop (256) + 1
    const l = tone(len, 48000, 700);
    const r = tone(len, 48000, 1400, 0.4);
    const mix = [l, r];
    fx.push({ name: 'len = hop+1 (stereo, 48k)', rate: 48000, mix, estimates: estimatesFromBands(mix) });
  }

  return fx;
}

// Reconstruction using the SAME arithmetic mixdownSession uses: a float32
// left-to-right running sum (Math.fround per add), sources ascending then
// residual last. This is the documented exact-sum contract.
function reconstruct(res: { stems: Float32Array[][]; residual: Float32Array[] }, channel: number): Float32Array {
  const S = res.stems.length;
  const len = res.residual[channel].length;
  const total = new Float32Array(len);
  for (let n = 0; n < len; n++) {
    let acc = 0;
    for (let s = 0; s < S; s++) acc = Math.fround(acc + res.stems[s][channel][n]);
    acc = Math.fround(acc + res.residual[channel][n]);
    total[n] = acc;
  }
  return total;
}

describe('partitionStems — exact-sum guarantee (ruling 1 / ruling 4)', () => {
  const fixtures = buildFixtures();

  it.each(fixtures.map((f) => [f.name, f] as const))(
    'Σ stems + residual reconstructs the mix bit-exactly: %s',
    (_name, f) => {
      const res = partitionStems(f.mix, f.estimates);
      // Shape checks.
      expect(res.stems.length).toBe(f.estimates.length);
      expect(res.residual.length).toBe(f.mix.length);
      for (let c = 0; c < f.mix.length; c++) {
        expect(res.residual[c].length).toBe(f.mix[c].length);
        for (let s = 0; s < res.stems.length; s++) {
          expect(res.stems[s][c].length).toBe(f.mix[c].length);
        }
      }
      // THE exact-sum property, under the float32 mixdown accumulation: every
      // sample reconstructs the mix either bit-exactly (===) or, only where |mix|
      // sits below the local float32 ULP of the stem sum (near a zero crossing),
      // within the documented float32-granularity bound. No NaN anywhere.
      const BOUND = 1e-12; // >> observed ~8.7e-16, robust; ≈ -240 dBFS.
      for (let c = 0; c < f.mix.length; c++) {
        const total = reconstruct(res, c);
        for (let n = 0; n < f.mix[c].length; n++) {
          expect(Number.isNaN(total[n])).toBe(false);
          const err = Math.abs(total[n] - f.mix[c][n]);
          if (err !== 0) expect(err).toBeLessThanOrEqual(BOUND);
        }
      }
    }
  );

  it('reports the worst-case reconstruction error and per-sample exactness across all fixtures', () => {
    let worstAbs = 0;
    let worstDb = -Infinity;
    let totalSamples = 0;
    let exactSamples = 0;
    for (const f of fixtures) {
      const res = partitionStems(f.mix, f.estimates);
      for (let c = 0; c < f.mix.length; c++) {
        const total = reconstruct(res, c);
        for (let n = 0; n < f.mix[c].length; n++) {
          totalSamples++;
          const err = Math.abs(total[n] - f.mix[c][n]);
          if (err === 0) exactSamples++;
          if (err > worstAbs) worstAbs = err;
        }
      }
    }
    worstDb = 20 * Math.log10(worstAbs + Number.MIN_VALUE);
    const exactPct = ((100 * exactSamples) / totalSamples).toFixed(4);
    // eslint-disable-next-line no-console
    console.log(
      `[stemPartition] exact-sum: ${exactSamples}/${totalSamples} samples bit-exact (${exactPct}%); ` +
        `worst |error| = ${worstAbs.toExponential(3)} (${worstDb.toFixed(1)} dBFS)`
    );
    // Documented bound: float32 storage granularity, ≈ -300 dBFS. Achieved
    // 8.689e-16; asserted at 1e-14 — enough headroom for cross-machine float
    // variation, tight enough that an exactness regression cannot hide.
    expect(worstAbs).toBeLessThanOrEqual(1e-14);
    // The overwhelming majority of samples are literally bit-exact (achieved 0.9974).
    expect(exactSamples / totalSamples).toBeGreaterThan(0.99);
  });
});

describe('partitionStems — mask laws', () => {
  it('every mask lies in [0,1] and Σ masks ≤ 1 (+tiny eps) at every bin', () => {
    const len = 8000;
    const mix = [tone(len, 48000, 440), tone(len, 48000, 880, 0.5)];
    const estimates = estimatesFromBands(mix);
    const res = partitionStems(mix, estimates, { collectStats: true });
    expect(res.stats).toBeDefined();
    const s = res.stats!;
    expect(s.maskMin).toBeGreaterThanOrEqual(0);
    expect(s.maskMax).toBeLessThanOrEqual(1);
    expect(s.maxMaskSum).toBeLessThanOrEqual(1 + 1e-6);
  });

  it('routes a bin whose estimates are all ~0 to the Residual with no NaN', () => {
    const len = 4096;
    const rand = makeRand(2024);
    const x = new Float32Array(len);
    for (let n = 0; n < len; n++) x[n] = rand();
    const mix = [x];
    const est: Float32Array[][] = [[zeros(len)], [zeros(len)]];
    const res = partitionStems(mix, est);
    // Every stem is exactly silent; residual carries the whole mix bit-exactly.
    for (let s = 0; s < res.stems.length; s++) {
      for (let n = 0; n < len; n++) expect(res.stems[s][0][n]).toBe(0);
    }
    for (let n = 0; n < len; n++) {
      expect(Number.isNaN(res.residual[0][n])).toBe(false);
      expect(res.residual[0][n]).toBe(x[n]);
    }
  });
});

describe('ratioMaskBin — pure per-bin Wiener ratio mask', () => {
  it('assigns a dominant source ~all the energy and none negative', () => {
    const m = ratioMaskBin(new Float32Array([9, 0, 0, 0]), 1e-10);
    expect(m[0]).toBeGreaterThan(0.999999);
    expect(m[1]).toBe(0);
    expect(m[2]).toBe(0);
    expect(m[3]).toBe(0);
  });

  it('splits proportionally to energy and sums to <= 1', () => {
    const m = ratioMaskBin(new Float32Array([3, 1]), 1e-12);
    expect(m[0]).toBeCloseTo(0.75, 6);
    expect(m[1]).toBeCloseTo(0.25, 6);
    let sum = 0;
    for (const v of m) sum += v;
    expect(sum).toBeLessThanOrEqual(1 + 1e-9);
  });

  it('returns all zeros (no NaN) when every estimate is zero', () => {
    const m = ratioMaskBin(new Float32Array([0, 0, 0]), 1e-10);
    for (const v of m) {
      expect(Number.isNaN(v)).toBe(false);
      expect(v).toBe(0);
    }
  });

  it('keeps every mask within [0,1]', () => {
    const m = ratioMaskBin(new Float32Array([5, 2, 1, 0.5]), 1e-10);
    let sum = 0;
    for (const v of m) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
      sum += v;
    }
    // Masks are stored float32, so the exact-arithmetic Σ ≤ 1 can drift up by a
    // few f32 ULPs across sources; the meaningful bound is f32-rounding, not 0.
    expect(sum).toBeLessThanOrEqual(1 + 1e-6);
  });
});

// ---------------------------------------------------------------------------
// STEM CONTENT — the assertions that guard the "don't pollute one instrument
// with another" constraint. Exact-sum is structurally BLIND to every finite
// error here (the time-domain residual absorbs any of them), so each shipped
// numeric path needs its own assertion on stem CONTENT, not just on the sum.
// ---------------------------------------------------------------------------

/** RMS over the interior (away from both ragged OLA ends). */
function interiorRms(x: Float32Array, guard: number): number {
  let acc = 0;
  let n = 0;
  for (let i = guard; i < x.length - guard; i++) {
    acc += x[i] * x[i];
    n++;
  }
  return n === 0 ? 0 : Math.sqrt(acc / n);
}

/**
 * Energy-weighted spectral centroid, in bins — where a signal's energy sits on
 * the frequency axis. Low-band content pulls it down, high-band content up.
 */
function spectralCentroid(x: Float32Array): number {
  const { fftSize, hop } = DEFAULT_STEM_PARTITION_OPTIONS;
  const f = stft(x, fftSize, hop);
  let num = 0;
  let den = 0;
  for (const mag of f.frames) {
    for (let k = 0; k < mag.length; k++) {
      const e = mag[k] * mag[k];
      num += k * e;
      den += e;
    }
  }
  return den === 0 ? 0 : num / den;
}

describe('spectralEnergyInto — the shipped |X|² law (partitionStems calls THIS)', () => {
  it('computes re² + im² per bin — the imaginary term is load-bearing', () => {
    const re = new Float32Array([3, 0, -1, 2]);
    const im = new Float32Array([4, 5, 0, -2]);
    const out = new Float32Array(4);
    spectralEnergyInto(re, im, 4, out);
    expect(out[0]).toBeCloseTo(25, 5); // 3²+4²
    expect(out[1]).toBeCloseTo(25, 5); // 0²+5²  <- zero without the im term
    expect(out[2]).toBeCloseTo(1, 5); // (-1)²+0²
    expect(out[3]).toBeCloseTo(8, 5); // 2²+(-2)²
  });

  it('gives a purely-imaginary bin its full energy (not zero)', () => {
    const re = new Float32Array([0]);
    const im = new Float32Array([7]);
    const out = new Float32Array(1);
    spectralEnergyInto(re, im, 1, out);
    expect(out[0]).toBeCloseTo(49, 5);
  });

  it('writes only the requested bin count', () => {
    const re = new Float32Array([1, 1, 1, 1]);
    const im = new Float32Array([0, 0, 0, 0]);
    const out = new Float32Array(4);
    spectralEnergyInto(re, im, 2, out);
    expect(Array.from(out)).toEqual([1, 1, 0, 0]);
  });
});

describe('ratioMaskBinInto — the shipped ratio law (allocation-free hot path)', () => {
  it('agrees with the allocating ratioMaskBin wrapper', () => {
    const e = new Float32Array([4, 1, 0.5, 0]);
    const out = new Float32Array(4);
    const sum = ratioMaskBinInto(e, 1e-10, out);
    const ref = ratioMaskBin(e, 1e-10);
    expect(Array.from(out)).toEqual(Array.from(ref));
    let refSum = 0;
    for (const v of ref) refSum += v;
    expect(sum).toBeCloseTo(refSum, 12);
  });

  it('returns Σ masks and zeroes an all-silent bin', () => {
    const out = new Float32Array(3);
    const sum = ratioMaskBinInto(new Float32Array([0, 0, 0]), 1e-10, out);
    expect(sum).toBe(0);
    expect(Array.from(out)).toEqual([0, 0, 0]);
  });
});

describe('partitionStems — the SHIPPED mask law, pinned end-to-end', () => {
  // Two equal-amplitude sources at the SAME bin, in quadrature: a sine (purely
  // IMAGINARY spectrum) and a cosine (purely REAL). The Wiener power law gives
  // them equal energy -> masks 0.5/0.5. Dropping the imaginary term from the
  // shipped energy collapses the sine's energy to ~0, handing the cosine
  // everything — so this test pins the shipped |X|² through partitionStems.
  const FFT = DEFAULT_STEM_PARTITION_OPTIONS.fftSize;
  const BIN = 8; // multiple of 4 => identical phase alignment at hop = N/4
  const len = 8192;

  function buildQuadratureCase() {
    const a = new Float32Array(len);
    const b = new Float32Array(len);
    const mix = new Float32Array(len);
    for (let n = 0; n < len; n++) {
      a[n] = 0.5 * Math.sin((2 * Math.PI * BIN * n) / FFT);
      b[n] = 0.5 * Math.cos((2 * Math.PI * BIN * n) / FFT);
      mix[n] = a[n] + b[n];
    }
    return { a, b, mix };
  }

  it('splits two equal-energy quadrature sources ~50/50 (imaginary term load-bearing)', () => {
    const { a, b, mix } = buildQuadratureCase();
    const res = partitionStems([mix], [[a], [b]]);
    const rMix = interiorRms(mix, FFT);
    const rA = interiorRms(res.stems[0][0], FFT);
    const rB = interiorRms(res.stems[1][0], FFT);
    // Equal energies -> equal shares. (Mutation: rA -> ~0, rB -> ~rMix.)
    expect(rA / rB).toBeGreaterThan(0.95);
    expect(rA / rB).toBeLessThan(1.05);
    // Each stem carries ~half the mix.
    expect(rA / rMix).toBeGreaterThan(0.45);
    expect(rA / rMix).toBeLessThan(0.55);
    expect(rB / rMix).toBeGreaterThan(0.45);
    expect(rB / rMix).toBeLessThan(0.55);
  });

  it('keeps the sine source audible (a dropped imaginary term would silence it)', () => {
    const { a, b, mix } = buildQuadratureCase();
    const res = partitionStems([mix], [[a], [b]]);
    const rMix = interiorRms(mix, FFT);
    // The sine stem must hold real energy, not the ~0 a re²-only law would give.
    expect(interiorRms(res.stems[0][0], FFT)).toBeGreaterThan(0.2 * rMix);
  });
});

describe('partitionStems — the SHIPPED OLA normalizer, pinned end-to-end', () => {
  // A single source whose estimate IS the mix gets mask ~1, so its stem is an
  // UNMASKED analysis/synthesis round trip through partitionStems' own winSq
  // path. Any gain error in that normalizer (e.g. dividing by winSq*2) shows up
  // here as an amplitude error — while exact-sum stays green, because the
  // residual silently absorbs the missing half.
  const FFT = DEFAULT_STEM_PARTITION_OPTIONS.fftSize;

  it('reconstructs the mix in the sole stem within the round-trip bound (unity gain)', () => {
    const len = 20000;
    const rand = makeRand(31337);
    const x = new Float32Array(len);
    for (let n = 0; n < len; n++) x[n] = rand();
    const res = partitionStems([x], [[x], [zeros(len)], [zeros(len)], [zeros(len)]]);
    let maxErr = 0;
    for (let n = FFT; n < len - FFT; n++) maxErr = Math.max(maxErr, Math.abs(res.stems[0][0][n] - x[n]));
    // eslint-disable-next-line no-console
    console.log(
      `[stemPartition] unmasked round trip THROUGH partitionStems: max|err| = ${maxErr.toExponential(3)} ` +
        `(${(20 * Math.log10(maxErr + Number.MIN_VALUE)).toFixed(1)} dB)`
    );
    expect(maxErr).toBeLessThan(1e-4);
    // Silent sources stay exactly silent.
    for (let n = 0; n < len; n++) expect(res.stems[1][0][n]).toBe(0);
  });

  it('holds unity gain for a tone (RMS of the sole stem equals the mix)', () => {
    const len = 12000;
    const x = tone(len, 44100, 440, 0.8);
    const res = partitionStems([x], [[x], [zeros(len)]]);
    const rMix = interiorRms(x, FFT);
    const rStem = interiorRms(res.stems[0][0], FFT);
    // Mutating the normalizer (winSq*2) halves this ratio.
    expect(rStem / rMix).toBeGreaterThan(0.99);
    expect(rStem / rMix).toBeLessThan(1.01);
  });
});

describe('partitionStems — stem content follows the estimates (band-split net)', () => {
  it('routes the low-passed estimate the low band and the high-passed one the high band', () => {
    const len = 16000;
    const rand = makeRand(777);
    const x = new Float32Array(len);
    for (let n = 0; n < len; n++) x[n] = rand();
    const [lp, hp] = bandSplit(x);
    const res = partitionStems([x], [[lp], [hp]]);
    const centMix = spectralCentroid(x);
    const centLowStem = spectralCentroid(res.stems[0][0]);
    const centHighStem = spectralCentroid(res.stems[1][0]);
    // eslint-disable-next-line no-console
    console.log(
      `[stemPartition] band-split content (centroid, bins): mix=${centMix.toFixed(1)} ` +
        `lowStem=${centLowStem.toFixed(1)} highStem=${centHighStem.toFixed(1)}`
    );
    // The stems must be spectrally SEPARATED — the whole point of the masks.
    // A corrupted mask law hands one source everything, collapsing both stems
    // toward the mix's own centroid and killing this ordering.
    expect(centLowStem).toBeLessThan(centMix);
    expect(centHighStem).toBeGreaterThan(centMix);
    expect(centHighStem).toBeGreaterThan(centLowStem * 2);
    // And each stem must actually carry energy (neither is silenced).
    expect(interiorRms(res.stems[0][0], 1024)).toBeGreaterThan(0);
    expect(interiorRms(res.stems[1][0], 1024)).toBeGreaterThan(0);
  });

  // Every content case above is MONO, so nothing in them can tell
  // `estimates[s][c]` from `estimates[s][0]`: a channel index dropped in the
  // analysis loop would mask channel 1 with channel 0's estimates, and
  // exact-sum absorbs the whole swap in the residual. This fixture makes the
  // two channels disagree about WHICH source owns the low band, so a stem that
  // followed the wrong channel's estimate is audible as a flipped centroid.
  it('masks each channel with ITS OWN estimate — swapped stereo routing does not leak across channels', () => {
    const len = 16000;
    const randL = makeRand(4242);
    const randR = makeRand(90210);
    const xL = new Float32Array(len);
    const xR = new Float32Array(len);
    for (let n = 0; n < len; n++) {
      xL[n] = randL();
      xR[n] = randR();
    }
    const [lpL, hpL] = bandSplit(xL);
    const [lpR, hpR] = bandSplit(xR);
    // Source 0 is the LOW band on the left and the HIGH band on the right;
    // source 1 is its mirror. Nothing about channel 0 predicts channel 1.
    const res = partitionStems([xL, xR], [[lpL, hpR], [hpL, lpR]]);

    const centL = spectralCentroid(xL);
    const centR = spectralCentroid(xR);
    const s0L = spectralCentroid(res.stems[0][0]);
    const s1L = spectralCentroid(res.stems[1][0]);
    const s0R = spectralCentroid(res.stems[0][1]);
    const s1R = spectralCentroid(res.stems[1][1]);
    // eslint-disable-next-line no-console
    console.log(
      `[stemPartition] swapped stereo routing (centroid, bins): L mix=${centL.toFixed(1)} ` +
        `s0=${s0L.toFixed(1)} s1=${s1L.toFixed(1)} | R mix=${centR.toFixed(1)} ` +
        `s0=${s0R.toFixed(1)} s1=${s1R.toFixed(1)}`
    );

    // Channel 0: source 0 low, source 1 high.
    expect(s0L).toBeLessThan(centL);
    expect(s1L).toBeGreaterThan(centL);
    expect(s1L).toBeGreaterThan(s0L * 2);
    // Channel 1: the ORDER IS REVERSED. A stem masked with channel 0's
    // estimates would come back low here, not high.
    expect(s0R).toBeGreaterThan(centR);
    expect(s1R).toBeLessThan(centR);
    expect(s0R).toBeGreaterThan(s1R * 2);
    // Neither channel of either stem is silenced by the routing.
    for (const s of [0, 1]) {
      for (const c of [0, 1]) expect(interiorRms(res.stems[s][c], 1024)).toBeGreaterThan(0);
    }
  });
});

describe('partitionStems — input validation', () => {
  const good = () => new Float32Array(64);

  it('throws on a NaN sample in an estimate (never produces NaN audio)', () => {
    const mix = [good()];
    const bad = good();
    bad[10] = NaN;
    expect(() => partitionStems(mix, [[bad], [good()]])).toThrow(/estimates\[0\]\[0\]\[10\] is not finite/);
  });

  it('throws on an Infinity sample in an estimate', () => {
    const mix = [good()];
    const bad = good();
    bad[5] = Infinity;
    expect(() => partitionStems(mix, [[bad]])).toThrow(/not finite/);
  });

  it('throws on a non-finite sample in the mix', () => {
    const bad = good();
    bad[3] = NaN;
    expect(() => partitionStems([bad], [[good()]])).toThrow(/mix\[0\]\[3\] is not finite/);
  });

  it('accepts finite input at the rails (±1.0) without throwing', () => {
    const x = good();
    x.fill(1);
    x[0] = -1;
    expect(() => partitionStems([x], [[x]])).not.toThrow();
  });

  it('throws on a channel-count mismatch between mix and an estimate', () => {
    expect(() => partitionStems([good(), good()], [[good()]])).toThrow(/has 1 channels, expected 2/);
  });

  it('throws on a length mismatch between mix and an estimate', () => {
    expect(() => partitionStems([good()], [[new Float32Array(32)]])).toThrow(/length 32 != mix\[0\] length 64/);
  });

  it('throws on an empty mix or an empty estimate set', () => {
    expect(() => partitionStems([], [[good()]])).toThrow(/at least one channel/);
    expect(() => partitionStems([good()], [])).toThrow(/at least one source/);
  });

  it('throws on a non-power-of-two fftSize, a bad hop, or a non-positive eps', () => {
    const mix = [good()];
    const est = [[good()]];
    expect(() => partitionStems(mix, est, { fftSize: 1000 })).toThrow(/power of two/);
    expect(() => partitionStems(mix, est, { fftSize: 1024, hop: 0 })).toThrow(/hop must be in/);
    expect(() => partitionStems(mix, est, { fftSize: 1024, hop: 2048 })).toThrow(/hop must be in/);
    expect(() => partitionStems(mix, est, { eps: 0 })).toThrow(/eps must be > 0/);
  });
});

describe('COLA — analysis·synthesis window overlap-adds to a constant', () => {
  it('Hann² tiles to a constant in the interior at the default hop (75% overlap)', () => {
    const { fftSize, hop } = DEFAULT_STEM_PARTITION_OPTIONS;
    const energy = colaWindowEnergy(fftSize, hop, 64); // 64 frames
    // Interior samples (away from both ragged ends) must be constant.
    const lo = fftSize;
    const hi = energy.length - fftSize;
    let min = Infinity;
    let max = -Infinity;
    for (let n = lo; n < hi; n++) {
      min = Math.min(min, energy[n]);
      max = Math.max(max, energy[n]);
    }
    expect(max - min).toBeLessThan(1e-6);
    // Hann² at hop = N/4 overlap-adds to exactly 1.5 — pin the constant, not just ">0".
    expect(min).toBeCloseTo(1.5, 5);
    // eslint-disable-next-line no-console
    console.log(`[stemPartition] COLA interior constant (Hann², hop=N/4) = ${min.toFixed(6)}`);
  });
});

describe('iSTFT(STFT(x)) round-trip — reconstruction quality the residual absorbs', () => {
  it('reports interior round-trip error for the chosen window/hop', () => {
    const { fftSize, hop } = DEFAULT_STEM_PARTITION_OPTIONS;
    const len = 20000;
    const rand = makeRand(555);
    const x = new Float32Array(len);
    for (let n = 0; n < len; n++) x[n] = rand();
    const y = istft(stft(x, fftSize, hop), len);
    let maxErr = 0;
    for (let n = fftSize; n < len - fftSize; n++) maxErr = Math.max(maxErr, Math.abs(y[n] - x[n]));
    const db = 20 * Math.log10(maxErr + Number.MIN_VALUE);
    // eslint-disable-next-line no-console
    console.log(
      `[stemPartition] iSTFT(STFT(x)) interior round-trip: max|err| = ${maxErr.toExponential(3)} (${db.toFixed(1)} dB)`
    );
    expect(maxErr).toBeLessThan(1e-4);
  });
});
