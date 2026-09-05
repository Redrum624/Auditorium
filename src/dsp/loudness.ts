/**
 * ITU-R BS.1770-4 integrated loudness, in LUFS.
 *
 * D5 — this is the ONLY LUFS in the app. `coverMatch.ts`'s `gatedLevelDb` is a
 * gated dBFS programme level with no K-weighting and no block structure, and its
 * own comment says it must not be called LUFS; it stays what it is.
 *
 * The measurement, in the standard's order:
 *   1. K-weighting: a high shelf (stage 1) then a high pass (stage 2), per
 *      channel, designed for the DOCUMENT's sample rate — never a copied table.
 *   2. 400 ms blocks at 75 % overlap (a 100 ms hop); `z_i` is the mean square of
 *      the K-weighted channel over the block.
 *   3. Block loudness `l_j = -0.691 + 10*log10(SUM_i G_i * z_ij)`.
 *   4. Absolute gate at -70 LUFS, then a relative gate 10 LU below the loudness
 *      of what the absolute gate kept.
 *   5. The integrated value is that same formula over the surviving blocks'
 *      mean `z_i`.
 *
 * Pure and allocation-light: nothing is allocated per sample, the input is never
 * mutated, and there is no worker — a 20 s stereo measurement is a few
 * milliseconds of straight-line filtering.
 */

import type { BiquadCoeffs } from './biquad';

/** The rate at which the standard publishes its coefficient table. */
export const K_WEIGHTING_REFERENCE_RATE = 48000;

/** Gating block length. */
export const LOUDNESS_BLOCK_MS = 400;

/** Gating block hop — 100 ms into a 400 ms block is the standard's 75 % overlap. */
export const LOUDNESS_HOP_MS = 100;

/** Blocks quieter than this never count, however quiet the programme is. */
export const ABSOLUTE_GATE_LUFS = -70;

/** The relative gate sits this far below the absolute-gated loudness. */
export const RELATIVE_GATE_LU = -10;

/** The -0.691 dB in `L = -0.691 + 10*log10(SUM G_i z_i)`. */
const LOUDNESS_OFFSET_DB = -0.691;

/**
 * The analogue prototype BS.1770-4 publishes its 48 kHz table FROM. Designing
 * from these at the document's own rate is the whole point: resampling a
 * measurement, or reusing 48 kHz poles at 44.1 kHz, moves the shelf corner by
 * ~10 % and the reading with it.
 */
const SHELF_GAIN_DB = 3.999843853973347;
const SHELF_Q = 0.7071752369554196;
const SHELF_FREQ_HZ = 1681.974450955533;
/** The shelf-slope exponent of the standard's parameterisation (~= 1/2). */
const SHELF_SLOPE_EXPONENT = 0.4996667741545416;

const HIGHPASS_FREQ_HZ = 38.13547087602444;
const HIGHPASS_Q = 0.5003270373238773;

export interface KWeightingCoeffs {
  /** Stage 1: the +4 dB high shelf that models the head's acoustic gain. */
  stage1: BiquadCoeffs;
  /** Stage 2: the ~38 Hz high pass ("RLB"). */
  stage2: BiquadCoeffs;
}

/**
 * Design the two K-weighting biquads for `sampleRate` by bilinear transform of
 * the prototype above.
 *
 * NOT `designBiquad('highshelf', ...)`: the RBJ cookbook shelf uses a different
 * slope parameterisation (`A = 10^(G/40)`, `2*sqrt(A)*alpha`) and lands ~0.04
 * off the standard's b2 at 48 kHz — visible in the reading. The standard's own
 * form, with `Vh = 10^(G/20)` and `Vb = Vh^0.49967`, reproduces the published
 * table to machine precision. Same story for stage 2: the poles are the RBJ
 * high-pass poles, but the numerator stays the unnormalised `[1, -2, 1]` the
 * standard tabulates rather than RBJ's `(1+cos w0)/2` scaling.
 */
export function designKWeighting(sampleRate: number): KWeightingCoeffs {
  const k1 = Math.tan((Math.PI * SHELF_FREQ_HZ) / sampleRate);
  const vh = Math.pow(10, SHELF_GAIN_DB / 20);
  const vb = Math.pow(vh, SHELF_SLOPE_EXPONENT);
  const d1 = 1 + k1 / SHELF_Q + k1 * k1;
  const stage1: BiquadCoeffs = {
    b0: (vh + (vb * k1) / SHELF_Q + k1 * k1) / d1,
    b1: (2 * (k1 * k1 - vh)) / d1,
    b2: (vh - (vb * k1) / SHELF_Q + k1 * k1) / d1,
    a1: (2 * (k1 * k1 - 1)) / d1,
    a2: (1 - k1 / SHELF_Q + k1 * k1) / d1,
  };

  const k2 = Math.tan((Math.PI * HIGHPASS_FREQ_HZ) / sampleRate);
  const d2 = 1 + k2 / HIGHPASS_Q + k2 * k2;
  const stage2: BiquadCoeffs = {
    b0: 1,
    b1: -2,
    b2: 1,
    a1: (2 * (k2 * k2 - 1)) / d2,
    a2: (1 - k2 / HIGHPASS_Q + k2 * k2) / d2,
  };

  return { stage1, stage2 };
}

/**
 * Energy of every 100 ms hop-segment of one K-weighted channel.
 *
 * The two biquads run in ONE pass with scalar state, and only the per-segment
 * sums of squares are kept — a 400 ms block is then four consecutive segments,
 * so the 75 % overlap costs no extra filtering and the filtered signal is never
 * materialised. `out` is written in place; nothing is allocated in the loop.
 */
function segmentEnergies(
  channel: Float32Array,
  coeffs: KWeightingCoeffs,
  hop: number,
  out: Float64Array
): void {
  const { stage1, stage2 } = coeffs;
  // Stage 1 state (x = input, y = shelf output), stage 2 state (u = shelf
  // output delayed, v = high-pass output).
  let x1 = 0;
  let x2 = 0;
  let y1 = 0;
  let y2 = 0;
  let u1 = 0;
  let u2 = 0;
  let v1 = 0;
  let v2 = 0;

  for (let seg = 0; seg < out.length; seg++) {
    const base = seg * hop;
    let energy = 0;
    for (let i = 0; i < hop; i++) {
      const x0 = channel[base + i];
      const y0 = stage1.b0 * x0 + stage1.b1 * x1 + stage1.b2 * x2 - stage1.a1 * y1 - stage1.a2 * y2;
      x2 = x1;
      x1 = x0;
      y2 = y1;
      y1 = y0;
      const v0 = stage2.b0 * y0 + stage2.b1 * u1 + stage2.b2 * u2 - stage2.a1 * v1 - stage2.a2 * v2;
      u2 = u1;
      u1 = y0;
      v2 = v1;
      v1 = v0;
      energy += v0 * v0;
    }
    out[seg] = energy;
  }
}

/**
 * Integrated loudness of `channels` in LUFS, or `null` when no 400 ms block
 * survives gating — an all-silent take, or anything shorter than one block.
 *
 * ACCURATE FOR MONO AND STEREO ONLY — deliberately, per D5.
 *
 * Every channel is weighted 1.0 and none is excluded. BS.1770-4 instead weights
 * the surround pair Ls/Rs at 1.41 (+1.5 dB) and leaves the LFE out of the sum
 * entirely, so on a surround document this reads low on the surrounds and counts
 * an LFE that should not count. That is a real reachable case, not a hypothetical
 * one: `decodeAudio.ts` hands a multichannel WAV's channels through WITHOUT a
 * downmix (only the non-WAV path folds to stereo), and `documentTools.ts`'s
 * `convertChannels` makes >2ch -> stereo an explicit user action — so a 5.1
 * document can be open and edited.
 *
 * D5 scopes this function to mono and stereo rather than carrying a channel
 * table, because `Float32Array[]` says nothing about which channel is Ls or LFE;
 * the layout lives in the document's `channelMask`, not here. A caller holding a
 * surround document must downmix first. D6's Podcast Chain, this measurement's
 * only consumer, refuses documents with more than two channels for exactly this
 * reason.
 *
 * Within that scope the equal weighting is the standard's: L and R both weigh 1,
 * so a mono document reads 3.01 LU below the same signal in both channels of a
 * stereo pair — which is exactly why D6's podcast target is -19 LUFS mono against
 * -16 LUFS stereo.
 *
 * Channels of unequal length are measured over their common span.
 */
export function integratedLoudness(
  channels: Float32Array[],
  sampleRate: number
): number | null {
  if (channels.length === 0 || !Number.isFinite(sampleRate) || sampleRate <= 0) return null;

  let length = Infinity;
  for (const channel of channels) length = Math.min(length, channel.length);
  if (!Number.isFinite(length) || length <= 0) return null;

  const hop = Math.round((sampleRate * LOUDNESS_HOP_MS) / 1000);
  if (hop <= 0) return null;
  const blockSegments = LOUDNESS_BLOCK_MS / LOUDNESS_HOP_MS; // 4
  const blockLength = hop * blockSegments;

  const segmentCount = Math.floor(length / hop);
  const blockCount = segmentCount - (blockSegments - 1);
  if (blockCount <= 0) return null;

  const coeffs = designKWeighting(sampleRate);

  // One Float64Array per channel; nothing per sample.
  const perChannel: Float64Array[] = [];
  for (const channel of channels) {
    const energies = new Float64Array(segmentCount);
    segmentEnergies(channel, coeffs, hop, energies);
    perChannel.push(energies);
  }

  // z[j] is already SUM_i G_i * z_ij with every G_i = 1.
  const z = new Float64Array(blockCount);
  for (let j = 0; j < blockCount; j++) {
    let sum = 0;
    for (const energies of perChannel) {
      let blockEnergy = 0;
      for (let s = 0; s < blockSegments; s++) blockEnergy += energies[j + s];
      sum += blockEnergy / blockLength;
    }
    z[j] = sum;
  }

  const blockLoudness = (value: number): number =>
    value > 0 ? LOUDNESS_OFFSET_DB + 10 * Math.log10(value) : -Infinity;

  // Absolute gate: silence and near-silence never count, whatever the rest does.
  let absoluteSum = 0;
  let absoluteCount = 0;
  for (let j = 0; j < blockCount; j++) {
    if (blockLoudness(z[j]) > ABSOLUTE_GATE_LUFS) {
      absoluteSum += z[j];
      absoluteCount++;
    }
  }
  if (absoluteCount === 0) return null;

  // Relative gate: 10 LU below the loudness of what the absolute gate kept, so a
  // quiet passage inside a loud programme drops out instead of dragging the
  // reading down.
  const relativeGate = blockLoudness(absoluteSum / absoluteCount) + RELATIVE_GATE_LU;

  let gatedSum = 0;
  let gatedCount = 0;
  for (let j = 0; j < blockCount; j++) {
    const l = blockLoudness(z[j]);
    if (l > ABSOLUTE_GATE_LUFS && l > relativeGate) {
      gatedSum += z[j];
      gatedCount++;
    }
  }
  if (gatedCount === 0) return null;

  return blockLoudness(gatedSum / gatedCount);
}

/**
 * Loudest single sample across all channels, in dBFS; `-Infinity` when every
 * sample is zero.
 *
 * SAMPLE peak, deliberately: there is no oversampling here, so this is never a
 * true-peak / dBTP reading and D6's limiter ceiling is documented as sample peak.
 */
export function samplePeakDb(channels: Float32Array[]): number {
  let peak = 0;
  for (const channel of channels) {
    for (let i = 0; i < channel.length; i++) {
      const magnitude = Math.abs(channel[i]);
      if (magnitude > peak) peak = magnitude;
    }
  }
  return peak > 0 ? 20 * Math.log10(peak) : -Infinity;
}

/**
 * The gain, in dB, that moves a programme measured at `measuredLufs` onto
 * `targetLufs`. Loudness is a log quantity, so the move is a subtraction.
 */
export function gainToTargetDb(measuredLufs: number, targetLufs: number): number {
  return targetLufs - measuredLufs;
}
