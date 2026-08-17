/**
 * Windowed-sinc sample-rate conversion (linear phase). For each output sample we
 * evaluate an ideal lowpass reconstruction kernel — a sinc bandlimited to the
 * lower of the two Nyquist rates (anti-aliasing on downsample) multiplied by a
 * Hann window spanning +/- TAPS_PER_SIDE input samples. Weights are normalized
 * per output sample so DC gain is exactly 1 (a constant signal stays constant).
 *
 * The kernel g(d) = 2fc·sinc(2fc·d)·hann(d) depends only on the fractional tap
 * distance `d` and the cutoff `fc`, so it is precomputed ONCE per fc into a
 * densely-sampled table (TABLE_OVERSAMPLE steps per unit tap spacing) and read
 * back with linear interpolation in the inner loop — replacing two transcendental
 * calls (sin for sinc, cos for the Hann window) per tap with a single table
 * lookup. Tables are cached by fc since a given conversion ratio reuses one fc.
 */

const TAPS_PER_SIDE = 32;
const PROGRESS_INTERVAL = 65536;

/** Table sampling density: entries per unit of tap spacing (per input sample). */
const TABLE_OVERSAMPLE = 512;
/** Total table entries covering d in [-TAPS_PER_SIDE, +TAPS_PER_SIDE] inclusive. */
const TABLE_SIZE = TAPS_PER_SIDE * 2 * TABLE_OVERSAMPLE + 1;

/** Normalized sinc: sin(pi*x)/(pi*x), with sinc(0) = 1. */
function sinc(x: number): number {
  if (x === 0) return 1;
  const px = Math.PI * x;
  return Math.sin(px) / px;
}

/** Precomputed kernel tables keyed by cutoff fc (conversions reuse ratios/fc).
 * Bounded to `MAX_KERNEL_ENTRIES` — fc is a continuous value, so a session
 * that resamples across many distinct rate pairs would otherwise accrete one
 * ~262 KB table per pair forever. Bounded by delete+set re-insertion with
 * oldest-first eviction, the same idiom as `tempoAnalysis.writeCache`: a hit
 * re-inserts its entry at the most-recently-used end, an insert past the cap
 * evicts from the oldest end. Eight tables cover far more simultaneous rate
 * pairs than any real session uses while capping the cache at ~2 MB. */
const kernelCache = new Map<number, Float64Array>();
const MAX_KERNEL_ENTRIES = 8;

/**
 * Returns the kernel table g(d) = 2fc·sinc(2fc·d)·hann(d) for the given cutoff,
 * sampled at TABLE_OVERSAMPLE steps per tap-spacing unit across
 * d ∈ [-TAPS_PER_SIDE, +TAPS_PER_SIDE]. Index i maps to
 * d = i/TABLE_OVERSAMPLE - TAPS_PER_SIDE. The Hann window is exactly 0 at the
 * endpoints, so the table tapers to 0 there. Cached per fc.
 */
function buildKernelTable(fc: number): Float64Array {
  const twoFc = 2 * fc;
  const invTaps = 1 / TAPS_PER_SIDE;
  const table = new Float64Array(TABLE_SIZE);
  for (let i = 0; i < TABLE_SIZE; i++) {
    const d = i / TABLE_OVERSAMPLE - TAPS_PER_SIDE;
    const win = 0.5 * (1 + Math.cos(Math.PI * d * invTaps));
    table[i] = twoFc * sinc(twoFc * d) * win;
  }
  return table;
}

function getKernelTable(fc: number): Float64Array {
  const cached = kernelCache.get(fc);
  if (cached) {
    // Refresh recency: delete+set re-insertion moves the entry to the MRU end.
    kernelCache.delete(fc);
    kernelCache.set(fc, cached);
    return cached;
  }
  const table = buildKernelTable(fc);
  kernelCache.set(fc, table);
  while (kernelCache.size > MAX_KERNEL_ENTRIES) {
    const oldest = kernelCache.keys().next().value as number | undefined;
    if (oldest === undefined) break;
    kernelCache.delete(oldest);
  }
  return table;
}

export function resampleChannel(
  input: Float32Array,
  fromRate: number,
  toRate: number,
  onProgress?: (fraction: number) => void
): Float32Array {
  if (input.length === 0) {
    onProgress?.(1);
    return new Float32Array(0);
  }

  if (fromRate === toRate) {
    const copy = new Float32Array(input.length);
    copy.set(input);
    onProgress?.(1);
    return copy;
  }

  const ratio = toRate / fromRate;
  const outLen = Math.round(input.length * ratio);
  const output = new Float32Array(outLen);

  const inLen = input.length;
  const step = fromRate / toRate; // input samples advanced per output sample
  // Normalized cutoff (cycles/sample of the INPUT). 0.5 when upsampling;
  // lowered to toRate/(2*fromRate) when downsampling for anti-aliasing.
  const fc = 0.5 * Math.min(1, ratio);
  const table = getKernelTable(fc);

  for (let i = 0; i < outLen; i++) {
    const pos = i * step; // fractional source position in input samples
    const center = Math.floor(pos);
    const first = center - TAPS_PER_SIDE + 1;
    const last = center + TAPS_PER_SIDE;

    let acc = 0;
    let weightSum = 0;
    for (let k = first; k <= last; k++) {
      const d = pos - k;
      if (d <= -TAPS_PER_SIDE || d >= TAPS_PER_SIDE) continue;
      if (k < 0 || k >= inLen) continue;
      // Read g(d) from the precomputed kernel table with linear interpolation.
      // d ∈ (-TAPS_PER_SIDE, TAPS_PER_SIDE) so the index stays within bounds and
      // i0 + 1 never exceeds the last entry.
      const fidx = (d + TAPS_PER_SIDE) * TABLE_OVERSAMPLE;
      const i0 = fidx | 0; // truncation = floor for the non-negative fidx here
      const frac = fidx - i0;
      const weight = table[i0] + frac * (table[i0 + 1] - table[i0]);
      weightSum += weight;
      acc += input[k] * weight;
    }

    output[i] = weightSum !== 0 ? acc / weightSum : 0;

    if (onProgress && (i & (PROGRESS_INTERVAL - 1)) === 0 && i !== 0) {
      onProgress(i / outLen);
    }
  }

  onProgress?.(1);
  return output;
}

/**
 * Variable-position windowed-sinc read: output[i] is the bandlimited
 * reconstruction of `input` at fractional position positions[i], using the
 * SAME kernel arithmetic as `resampleChannel` — a constant-step position array
 * (positions[i] = i·fromRate/toRate with the matching fc) reproduces
 * `resampleChannel` byte-for-byte, pinned in resample.test.ts. Used by
 * Pitch Correct's resynthesis, where the read rate follows the correction curve.
 *
 * `fc` is the normalized cutoff in INPUT cycles/sample: 0.5 when the local
 * read rate never exceeds 1 (no downsampling anywhere), otherwise
 * 0.5 / maxRate to anti-alias at the fastest read point. The caller supplies
 * it because only the caller knows the rate curve the positions were built
 * from. The kernel table is built per call and deliberately NOT entered into
 * the module cache: variable-rate callers derive fc from a per-run maximum, so
 * caching by arbitrary fc values would grow the cache without bound.
 */
export function resampleVariable(
  input: Float32Array,
  positions: Float64Array,
  fc: number,
  onProgress?: (fraction: number) => void
): Float32Array {
  const outLen = positions.length;
  const output = new Float32Array(outLen);
  if (outLen === 0 || input.length === 0) {
    onProgress?.(1);
    return output;
  }

  const inLen = input.length;
  const table = buildKernelTable(fc);

  for (let i = 0; i < outLen; i++) {
    const pos = positions[i];
    const center = Math.floor(pos);
    const first = center - TAPS_PER_SIDE + 1;
    const last = center + TAPS_PER_SIDE;

    let acc = 0;
    let weightSum = 0;
    for (let k = first; k <= last; k++) {
      const d = pos - k;
      if (d <= -TAPS_PER_SIDE || d >= TAPS_PER_SIDE) continue;
      if (k < 0 || k >= inLen) continue;
      const fidx = (d + TAPS_PER_SIDE) * TABLE_OVERSAMPLE;
      const i0 = fidx | 0; // truncation = floor for the non-negative fidx here
      const frac = fidx - i0;
      const weight = table[i0] + frac * (table[i0 + 1] - table[i0]);
      weightSum += weight;
      acc += input[k] * weight;
    }

    output[i] = weightSum !== 0 ? acc / weightSum : 0;

    if (onProgress && (i & (PROGRESS_INTERVAL - 1)) === 0 && i !== 0) {
      onProgress(i / outLen);
    }
  }

  onProgress?.(1);
  return output;
}
