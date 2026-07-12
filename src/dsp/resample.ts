/**
 * Windowed-sinc sample-rate conversion (linear phase). For each output sample we
 * evaluate an ideal lowpass reconstruction kernel — a sinc bandlimited to the
 * lower of the two Nyquist rates (anti-aliasing on downsample) multiplied by a
 * Hann window spanning +/- TAPS_PER_SIDE input samples. Weights are normalized
 * per output sample so DC gain is exactly 1 (a constant signal stays constant).
 */

const TAPS_PER_SIDE = 32;
const PROGRESS_INTERVAL = 65536;

/** Normalized sinc: sin(pi*x)/(pi*x), with sinc(0) = 1. */
function sinc(x: number): number {
  if (x === 0) return 1;
  const px = Math.PI * x;
  return Math.sin(px) / px;
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
  const twoFc = 2 * fc;
  const invTaps = 1 / TAPS_PER_SIDE;

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
      // Hann window (half-width TAPS_PER_SIDE): 0.5*(1 + cos(pi*d/N)).
      const win = 0.5 * (1 + Math.cos(Math.PI * d * invTaps));
      const weight = twoFc * sinc(twoFc * d) * win;
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
