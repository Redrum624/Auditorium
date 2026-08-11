import type { EffectDefinition } from '../types';
import { envelopeFollower, maxAcrossChannels, maybeReportProgress } from './envelope';

/**
 * dB-domain gain reduction with an optional soft knee (quadratic
 * interpolation inside the knee, standard formula):
 * - kneeDb <= 0: hard knee — `overDb * slope` above threshold, 0 below.
 * - `2*overDb < -kneeDb`: below the knee, no reduction.
 * - `2*|overDb| <= kneeDb`: inside the knee, quadratic interpolation.
 * - otherwise: above the knee, linear `overDb * slope`.
 */
export function reductionDb(overDb: number, ratio: number, kneeDb: number): number {
  const slope = 1 - 1 / ratio;
  if (kneeDb <= 0) {
    return overDb > 0 ? overDb * slope : 0;
  }
  if (2 * overDb < -kneeDb) return 0;
  if (2 * Math.abs(overDb) <= kneeDb) {
    return (slope * Math.pow(overDb + kneeDb / 2, 2)) / (2 * kneeDb);
  }
  return overDb * slope;
}

/**
 * Downward compressor. Sidechain detector = envelope follower of
 * max(|L|,|R|) (or the single channel for mono). Gain reduction is computed
 * per sample in the dB domain with a soft knee, applied identically to every
 * channel, then a constant makeup gain is applied.
 */
export const compressorEffect: EffectDefinition = {
  id: 'compressor',
  name: 'Compressor',
  category: 'Dynamics',
  params: [
    { id: 'thresholdDb', label: 'Threshold', type: 'number', min: -60, max: 0, step: 0.1, unit: 'dB', default: -20 },
    { id: 'ratio', label: 'Ratio', type: 'number', min: 1, max: 20, step: 0.1, default: 4 },
    { id: 'attackMs', label: 'Attack', type: 'number', min: 0.1, max: 200, step: 0.1, unit: 'ms', default: 10 },
    { id: 'releaseMs', label: 'Release', type: 'number', min: 5, max: 2000, step: 1, unit: 'ms', default: 100 },
    { id: 'kneeDb', label: 'Knee', type: 'number', min: 0, max: 12, step: 0.1, unit: 'dB', default: 6 },
    { id: 'makeupDb', label: 'Makeup Gain', type: 'number', min: -12, max: 24, step: 0.1, unit: 'dB', default: 0 },
  ],
  process(channels, sampleRate, params, onProgress) {
    const thresholdDb = Number(params.thresholdDb ?? -20);
    const ratio = Number(params.ratio ?? 4);
    const attackMs = Number(params.attackMs ?? 10);
    const releaseMs = Number(params.releaseMs ?? 100);
    const kneeDb = Number(params.kneeDb ?? 6);
    const makeupDb = Number(params.makeupDb ?? 0);
    const makeupLin = Math.pow(10, makeupDb / 20);

    const length = channels[0]?.length ?? 0;
    const detector = maxAcrossChannels(channels);
    const env = envelopeFollower(detector, sampleRate, attackMs, releaseMs);

    const out = channels.map((c) => new Float32Array(c.length));
    for (let i = 0; i < length; i++) {
      const envDb = 20 * Math.log10(Math.max(env[i], 1e-6));
      const overDb = envDb - thresholdDb;
      const gain = Math.pow(10, -reductionDb(overDb, ratio, kneeDb) / 20) * makeupLin;
      for (let ch = 0; ch < channels.length; ch++) {
        out[ch][i] = channels[ch][i] * gain;
      }
      maybeReportProgress(onProgress, i, length);
    }
    return { channels: out };
  },
};
