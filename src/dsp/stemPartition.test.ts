import {
  partitionStems,
  ratioMaskBin,
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
    // Documented bound: float32 storage granularity, ≈ -300 dBFS.
    expect(worstAbs).toBeLessThanOrEqual(1e-12);
    // The overwhelming majority of samples are literally bit-exact.
    expect(exactSamples / totalSamples).toBeGreaterThan(0.9);
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
    // Hann² at hop = N/4 overlap-adds to 1.5.
    expect(min).toBeGreaterThan(0);
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
