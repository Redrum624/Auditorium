/**
 * Radix-2 Cooley-Tukey FFT operating in place on separate real/imaginary
 * Float32Array buffers. Iterative implementation with a bit-reversal permutation;
 * per-stage twiddle factors are seeded with Math.cos/Math.sin and advanced by a
 * complex recurrence (no lookup table).
 */

/** Smallest power of two >= n. Returns 1 for n <= 1. */
export function nextPow2(n: number): number {
  if (n <= 1) return 1;
  let p = 1;
  while (p < n) p *= 2;
  return p;
}

/** Forward DFT: X[k] = sum_n x[n] e^{-j2*pi*k*n/N}. In place. */
export function fft(re: Float32Array, im: Float32Array): void {
  transform(re, im, false);
}

/** Inverse DFT, including the 1/N scaling. In place. */
export function ifft(re: Float32Array, im: Float32Array): void {
  transform(re, im, true);
}

function transform(re: Float32Array, im: Float32Array, inverse: boolean): void {
  const n = re.length;
  if (n === 0) {
    throw new Error('fft: length must be a power of two, got 0');
  }
  if ((n & (n - 1)) !== 0) {
    throw new Error(`fft: length must be a power of two, got ${n}`);
  }
  if (n === 1) {
    // X[0] = x[0]; inverse scaling by 1/1 is a no-op.
    return;
  }

  // Bit-reversal permutation.
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tr = re[i];
      re[i] = re[j];
      re[j] = tr;
      const ti = im[i];
      im[i] = im[j];
      im[j] = ti;
    }
  }

  // Forward transform uses e^{-j...}; inverse uses e^{+j...}.
  const sign = inverse ? 1 : -1;
  for (let len = 2; len <= n; len <<= 1) {
    const half = len >> 1;
    const ang = (sign * 2 * Math.PI) / len;
    const wRe = Math.cos(ang);
    const wIm = Math.sin(ang);
    for (let start = 0; start < n; start += len) {
      let curRe = 1;
      let curIm = 0;
      for (let k = 0; k < half; k++) {
        const a = start + k;
        const b = a + half;
        const tRe = re[b] * curRe - im[b] * curIm;
        const tIm = re[b] * curIm + im[b] * curRe;
        re[b] = re[a] - tRe;
        im[b] = im[a] - tIm;
        re[a] += tRe;
        im[a] += tIm;
        // Advance twiddle: cur *= w.
        const nextRe = curRe * wRe - curIm * wIm;
        curIm = curRe * wIm + curIm * wRe;
        curRe = nextRe;
      }
    }
  }

  if (inverse) {
    const invN = 1 / n;
    for (let i = 0; i < n; i++) {
      re[i] *= invN;
      im[i] *= invN;
    }
  }
}
