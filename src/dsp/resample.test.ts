import { resampleChannel, resampleVariable } from './resample';

/** Count sign changes (zero crossings) in a signal, ignoring exact zeros. */
function countZeroCrossings(x: Float32Array, start = 0, end = x.length): number {
  let count = 0;
  let prevSign = 0;
  for (let i = start; i < end; i++) {
    const s = x[i] > 0 ? 1 : x[i] < 0 ? -1 : 0;
    if (s !== 0) {
      if (prevSign !== 0 && s !== prevSign) count++;
      prevSign = s;
    }
  }
  return count;
}

describe('resampleChannel', () => {
  it('returns a copy (not the same reference) for identical rates', () => {
    const input = Float32Array.from([0.1, 0.2, 0.3, 0.4]);
    const out = resampleChannel(input, 44100, 44100);
    expect(out).not.toBe(input);
    expect(Array.from(out)).toEqual([
      0.1, 0.2, 0.3, 0.4,
    ].map((v) => Math.fround(v)));
  });

  it('handles empty input', () => {
    const out = resampleChannel(new Float32Array(0), 44100, 48000);
    expect(out).toHaveLength(0);
  });

  it('halves the length when downsampling 44100 -> 22050 (within +/-1)', () => {
    const input = new Float32Array(44100);
    for (let i = 0; i < input.length; i++) input[i] = Math.sin((2 * Math.PI * 440 * i) / 44100);
    const out = resampleChannel(input, 44100, 22050);
    expect(Math.abs(out.length - 22050)).toBeLessThanOrEqual(1);
  });

  it('doubles-ish the length when upsampling 44100 -> 48000', () => {
    const input = new Float32Array(44100);
    const out = resampleChannel(input, 44100, 48000);
    expect(out.length).toBe(Math.round(44100 * (48000 / 44100)));
  });

  it('preserves a 440Hz sine as 440Hz after 44100 -> 48000 (zero-crossing count within +/-1)', () => {
    const inLen = 44100; // 1.0s
    const input = new Float32Array(inLen);
    for (let i = 0; i < inLen; i++) input[i] = Math.sin((2 * Math.PI * 440 * i) / 44100);
    const out = resampleChannel(input, 44100, 48000);
    // Count zero crossings across an interior 0.5s window to avoid edge windowing.
    const start = 12000; // 0.25s into 48kHz output
    const end = start + 24000; // 0.5s window
    const crossings = countZeroCrossings(out, start, end);
    // 440 Hz over 0.5s -> 220 cycles -> 440 zero crossings.
    expect(Math.abs(crossings - 440)).toBeLessThanOrEqual(1);
  });

  it('keeps a constant 0.7 signal ~= 0.7 in the interior (edges excluded)', () => {
    const input = new Float32Array(4000);
    input.fill(0.7);
    const out = resampleChannel(input, 44100, 48000);
    const mid = Math.floor(out.length / 2);
    for (let i = mid - 50; i < mid + 50; i++) {
      expect(out[i]).toBeCloseTo(0.7, 3);
    }
  });

  it('resamples 1,000,000 samples 44100 -> 48000 in under 8 seconds', () => {
    const input = new Float32Array(1_000_000);
    for (let i = 0; i < input.length; i++) input[i] = Math.sin((2 * Math.PI * 1000 * i) / 44100);
    const t0 = performance.now();
    const out = resampleChannel(input, 44100, 48000);
    const elapsedMs = performance.now() - t0;
    expect(out.length).toBe(Math.round(1_000_000 * (48000 / 44100)));
    // Generous bound: measured ~450ms warm. 8s still catches an order-of-magnitude
    // regression while surviving CI/parallel-load contention (2s flaked repeatedly).
    expect(elapsedMs).toBeLessThan(8000);
  });

  it('reports progress ending at exactly 1.0', () => {
    const input = new Float32Array(20000);
    for (let i = 0; i < input.length; i++) input[i] = Math.sin(i * 0.1);
    const fractions: number[] = [];
    resampleChannel(input, 44100, 48000, (f) => fractions.push(f));
    expect(fractions.length).toBeGreaterThan(0);
    expect(fractions[fractions.length - 1]).toBe(1);
    for (const f of fractions) {
      expect(f).toBeGreaterThanOrEqual(0);
      expect(f).toBeLessThanOrEqual(1);
    }
  });
});

describe('resampleVariable', () => {
  function sine(freq: number, n: number, sr: number): Float32Array {
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) out[i] = Math.sin((2 * Math.PI * freq * i) / sr);
    return out;
  }

  it('unit-step integer positions at fc 0.5 reproduce the input to float-sinc precision', () => {
    // At fc = 0.5 the kernel is 1 at d = 0 and ~0 at every other integer tap —
    // "~" because Math.sin(π·k) is ≈1.2e-16 rather than exactly 0 for integer k,
    // so each off-centre tap leaks O(1e-16) (measured: 1.06e-17 at a true-zero
    // sample). 1e-12 gives two orders of headroom over the 63-tap worst case
    // while still being far below one 24-bit mantissa step of full-scale audio.
    const input = sine(440, 4096, 44100);
    const positions = new Float64Array(input.length);
    for (let i = 0; i < input.length; i++) positions[i] = i;
    const out = resampleVariable(input, positions, 0.5);
    expect(out.length).toBe(input.length);
    for (let i = 0; i < input.length; i++) {
      if (Math.abs(out[i] - input[i]) > 1e-12) {
        throw new Error(`sample ${i}: ${out[i]} vs ${input[i]}`);
      }
    }
  });

  it.each([
    [44100, 88200], // upsample ×2: step 0.5, fc 0.5
    [88200, 44100], // downsample ×2: step 2, fc 0.25
    // Non-dyadic pairs: step 147/160 resp. 160/147, so tap distances fall BETWEEN
    // kernel-table entries (frac ≠ 0) and the table interpolation genuinely runs —
    // the ×2 pairs above hit exact entries (frac = 0) and cannot see it.
    [44100, 48000], // upsample, fc 0.5, fractional table reads
    [48000, 44100], // downsample, fc = 0.5·44100/48000, fractional table reads
  ])('constant-step positions are byte-identical to resampleChannel (%d → %d)', (from, to) => {
    // Same per-sample arithmetic, same kernel builder — a constant-step position
    // array must reproduce the fixed-ratio path exactly, which pins that the
    // variable path shares (not reimplements) the resampler's behaviour.
    const input = sine(1000, 8192, from);
    const fixed = resampleChannel(input, from, to);
    const step = from / to;
    const positions = new Float64Array(fixed.length);
    for (let i = 0; i < fixed.length; i++) positions[i] = i * step;
    const fc = 0.5 * Math.min(1, to / from);
    const variable = resampleVariable(input, positions, fc);
    expect(variable.length).toBe(fixed.length);
    for (let i = 0; i < fixed.length; i++) {
      if (variable[i] !== fixed[i]) throw new Error(`sample ${i}: ${variable[i]} !== ${fixed[i]}`);
    }
  });

  it('empty positions or empty input yield an empty/zero output with terminal progress 1', () => {
    const fractions: number[] = [];
    expect(resampleVariable(new Float32Array(16), new Float64Array(0), 0.5, (f) => fractions.push(f)).length).toBe(0);
    expect(fractions[fractions.length - 1]).toBe(1);
    const out = resampleVariable(new Float32Array(0), new Float64Array(4), 0.5);
    expect(Array.from(out)).toEqual([0, 0, 0, 0]);
  });
});

describe('kernel table cache -- bounded LRU (public-repo L-04)', () => {
  // The cache is keyed by fc = 0.5 * min(1, toRate/fromRate), so every distinct
  // downsample target below yields a distinct entry (~262 KB each). The cap is
  // MAX_KERNEL_ENTRIES = 8, enforced with the house delete+set re-insertion
  // idiom (tempoAnalysis.writeCache): a hit re-inserts at the MRU end, an
  // insert past the cap evicts oldest-first.
  //
  // Builds are observed through Math.cos: buildKernelTable evaluates the Hann
  // window once per table entry, while the resampling inner loops only read the
  // finished table -- so cos calls during a resampleChannel run mean the table
  // was (re)built, and zero cos calls mean a cache hit.
  const FROM = 96000;
  /** 9 distinct downsample targets -> 9 distinct fc values, none colliding
   * with the fc 0.25 / 0.5 entries earlier tests already cached. */
  const rateAt = (i: number) => 8000 + i * 1000;

  function builds(toRate: number): boolean {
    const cos = jest.spyOn(Math, 'cos');
    try {
      resampleChannel(new Float32Array(64), FROM, toRate);
      return cos.mock.calls.length > 0;
    } finally {
      cos.mockRestore();
    }
  }

  it('holds 8 entries, evicts oldest-first on the 9th, and a hit refreshes recency', () => {
    // Fill exactly to the cap with 8 fresh fc values (evicting anything older).
    for (let i = 0; i < 8; i++) builds(rateAt(i));

    // All 8 fit: re-reading the first is a hit, and the hit moves it to MRU.
    expect(builds(rateAt(0))).toBe(false);

    // A 9th distinct fc crosses the boundary: the oldest entry is now
    // rateAt(1) (rateAt(0) was refreshed above), and only it gets evicted.
    expect(builds(rateAt(8))).toBe(true); // fresh fc -> built
    expect(builds(rateAt(0))).toBe(false); // survived: recency was refreshed
    expect(builds(rateAt(1))).toBe(true); // evicted at the boundary -> rebuilt
  });
});
