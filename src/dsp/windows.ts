/**
 * Analysis windows in their PERIODIC form (divisor N, not N-1), which is the
 * correct choice for STFT overlap-add: w[0] === 0 for Hann and the window tiles
 * seamlessly under constant overlap-add.
 */

/** Periodic Hann window: w[i] = 0.5 * (1 - cos(2*pi*i/N)). */
export function hann(size: number): Float32Array {
  const w = new Float32Array(size);
  for (let i = 0; i < size; i++) {
    w[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / size));
  }
  return w;
}

/** Periodic Hamming window: w[i] = 0.54 - 0.46 * cos(2*pi*i/N). */
export function hamming(size: number): Float32Array {
  const w = new Float32Array(size);
  for (let i = 0; i < size; i++) {
    w[i] = 0.54 - 0.46 * Math.cos((2 * Math.PI * i) / size);
  }
  return w;
}
