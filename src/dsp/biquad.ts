/**
 * Second-order IIR (biquad) filters from Robert Bristow-Johnson's Audio EQ
 * Cookbook. Coefficients are normalized by a0 and stored as the Direct Form I
 * difference equation:
 *
 *   y[n] = b0*x[n] + b1*x[n-1] + b2*x[n-2] - a1*y[n-1] - a2*y[n-2]
 */

export type BiquadType =
  | 'lowpass'
  | 'highpass'
  | 'bandpass'
  | 'notch'
  | 'peaking'
  | 'lowshelf'
  | 'highshelf';

export interface BiquadCoeffs {
  b0: number;
  b1: number;
  b2: number;
  a1: number;
  a2: number;
}

/**
 * Design an RBJ-cookbook biquad. `gainDb` is only used by peaking/lowshelf/
 * highshelf; it is ignored (and optional) for the other types.
 */
export function designBiquad(
  type: BiquadType,
  sampleRate: number,
  freq: number,
  q: number,
  gainDb = 0
): BiquadCoeffs {
  const w0 = (2 * Math.PI * freq) / sampleRate;
  const cosW0 = Math.cos(w0);
  const sinW0 = Math.sin(w0);
  const alpha = sinW0 / (2 * q);
  const A = Math.pow(10, gainDb / 40);

  let b0: number;
  let b1: number;
  let b2: number;
  let a0: number;
  let a1: number;
  let a2: number;

  switch (type) {
    case 'lowpass': {
      b0 = (1 - cosW0) / 2;
      b1 = 1 - cosW0;
      b2 = (1 - cosW0) / 2;
      a0 = 1 + alpha;
      a1 = -2 * cosW0;
      a2 = 1 - alpha;
      break;
    }
    case 'highpass': {
      b0 = (1 + cosW0) / 2;
      b1 = -(1 + cosW0);
      b2 = (1 + cosW0) / 2;
      a0 = 1 + alpha;
      a1 = -2 * cosW0;
      a2 = 1 - alpha;
      break;
    }
    case 'bandpass': {
      // Constant 0 dB peak gain variant.
      b0 = alpha;
      b1 = 0;
      b2 = -alpha;
      a0 = 1 + alpha;
      a1 = -2 * cosW0;
      a2 = 1 - alpha;
      break;
    }
    case 'notch': {
      b0 = 1;
      b1 = -2 * cosW0;
      b2 = 1;
      a0 = 1 + alpha;
      a1 = -2 * cosW0;
      a2 = 1 - alpha;
      break;
    }
    case 'peaking': {
      b0 = 1 + alpha * A;
      b1 = -2 * cosW0;
      b2 = 1 - alpha * A;
      a0 = 1 + alpha / A;
      a1 = -2 * cosW0;
      a2 = 1 - alpha / A;
      break;
    }
    case 'lowshelf': {
      const sqrtA = Math.sqrt(A);
      const twoSqrtAalpha = 2 * sqrtA * alpha;
      b0 = A * (A + 1 - (A - 1) * cosW0 + twoSqrtAalpha);
      b1 = 2 * A * (A - 1 - (A + 1) * cosW0);
      b2 = A * (A + 1 - (A - 1) * cosW0 - twoSqrtAalpha);
      a0 = A + 1 + (A - 1) * cosW0 + twoSqrtAalpha;
      a1 = -2 * (A - 1 + (A + 1) * cosW0);
      a2 = A + 1 + (A - 1) * cosW0 - twoSqrtAalpha;
      break;
    }
    case 'highshelf': {
      const sqrtA = Math.sqrt(A);
      const twoSqrtAalpha = 2 * sqrtA * alpha;
      b0 = A * (A + 1 + (A - 1) * cosW0 + twoSqrtAalpha);
      b1 = -2 * A * (A - 1 + (A + 1) * cosW0);
      b2 = A * (A + 1 + (A - 1) * cosW0 - twoSqrtAalpha);
      a0 = A + 1 - (A - 1) * cosW0 + twoSqrtAalpha;
      a1 = 2 * (A - 1 - (A + 1) * cosW0);
      a2 = A + 1 - (A - 1) * cosW0 - twoSqrtAalpha;
      break;
    }
    default: {
      const exhaustive: never = type;
      throw new Error(`designBiquad: unknown type ${String(exhaustive)}`);
    }
  }

  return {
    b0: b0 / a0,
    b1: b1 / a0,
    b2: b2 / a0,
    a1: a1 / a0,
    a2: a2 / a0,
  };
}

/**
 * Design a FIRST-ORDER (6 dB/oct) lowpass via the bilinear transform, returned
 * in the same biquad form (`b2 = a2 = 0`) so `processBiquad` runs it unchanged.
 *
 *   K = tan(pi*f/fs),  a = K/(1+K)
 *   H(z) = a*(1 + z^-1) / (1 - ((1-K)/(1+K)) * z^-1)
 *
 * Prewarped, so the corner lands exactly on `freq`: |H(0)| = 1, |H(freq)| =
 * 1/sqrt(2), |H(Nyquist)| = 0.
 *
 * Why first order, and why it is here: this is the LOW half of an
 * AMPLITUDE-COMPLEMENTARY crossover. Its high half is not a second filter but
 * the residual `x - lowpass(x)`, which for THIS design is itself a true
 * first-order highpass sharing the same pole:
 *
 *   1 - H(z) = (1/(1+K)) * (1 - z^-1) / (1 - ((1-K)/(1+K)) * z^-1)
 *
 * (zero at DC, unity at Nyquist). Two consequences: the two bands sum back to
 * the input SAMPLE-EXACTLY, and |H_lp|^2 + |H_hp|^2 = 1 at every frequency, so
 * neither half overshoots. Cascading the section (the de-esser uses two, for
 * reach) keeps the exact sum and costs a +0.97 dB bump in the residual at the
 * corner — still far better behaved than the alternatives, where a Butterworth
 * 2nd-order residual peaks at +1.76 dB and an LR4 residual at +3.5 dB, the
 * latter cancelling to a null once the band is pulled down past ~9.5 dB.
 */
export function designOnePoleLowpass(sampleRate: number, freq: number): BiquadCoeffs {
  const k = Math.tan((Math.PI * freq) / sampleRate);
  const a = k / (1 + k);
  return { b0: a, b1: a, b2: 0, a1: -(1 - k) / (1 + k), a2: 0 };
}

/**
 * Filter `input` through the biquad. Returns a NEW array; never mutates the
 * input. If `state` is supplied it carries x1/x2/y1/y2 across calls and is
 * MUTATED IN PLACE so successive chunks stitch together seamlessly; omit it for
 * a fresh zero-initialized run.
 */
export function processBiquad(
  input: Float32Array,
  coeffs: BiquadCoeffs,
  state?: { x1: number; x2: number; y1: number; y2: number }
): Float32Array {
  const { b0, b1, b2, a1, a2 } = coeffs;
  const out = new Float32Array(input.length);
  let x1 = state ? state.x1 : 0;
  let x2 = state ? state.x2 : 0;
  let y1 = state ? state.y1 : 0;
  let y2 = state ? state.y2 : 0;

  for (let i = 0; i < input.length; i++) {
    const x0 = input[i];
    const y0 = b0 * x0 + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    out[i] = y0;
    x2 = x1;
    x1 = x0;
    y2 = y1;
    y1 = y0;
  }

  if (state) {
    state.x1 = x1;
    state.x2 = x2;
    state.y1 = y1;
    state.y2 = y2;
  }
  return out;
}

/**
 * Magnitude response |H(e^{jw})| at `freq`, for EQ display and tests.
 * H(z) = (b0 + b1 z^-1 + b2 z^-2) / (1 + a1 z^-1 + a2 z^-2), z = e^{jw}.
 */
export function magnitudeAt(coeffs: BiquadCoeffs, freq: number, sampleRate: number): number {
  const { b0, b1, b2, a1, a2 } = coeffs;
  const w = (2 * Math.PI * freq) / sampleRate;
  const cos1 = Math.cos(w);
  const sin1 = Math.sin(w);
  const cos2 = Math.cos(2 * w);
  const sin2 = Math.sin(2 * w);

  // Using z^-1 = e^{-jw} = cos w - j sin w.
  const numRe = b0 + b1 * cos1 + b2 * cos2;
  const numIm = -(b1 * sin1 + b2 * sin2);
  const denRe = 1 + a1 * cos1 + a2 * cos2;
  const denIm = -(a1 * sin1 + a2 * sin2);

  const numMag = Math.hypot(numRe, numIm);
  const denMag = Math.hypot(denRe, denIm);
  return numMag / denMag;
}
