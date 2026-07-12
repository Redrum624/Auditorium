import type { EffectDefinition } from '../types';
import { maxAcrossChannels, maybeReportProgress } from './envelope';

const LOOKAHEAD_MS = 5; // fixed, not a user param

/**
 * Trailing sliding-window max of |signal| over the last `windowSize` samples
 * (inclusive of the current sample), computed in O(n) via a monotonic deque
 * of indices (values decreasing front-to-back). A plain head index is used
 * instead of `Array.shift()` to avoid O(n) per-removal reindexing.
 */
function slidingWindowMax(signal: Float32Array, windowSize: number): Float32Array {
  const length = signal.length;
  const out = new Float32Array(length);
  const idx: number[] = [];
  let head = 0;
  for (let i = 0; i < length; i++) {
    const v = signal[i];
    while (idx.length > head && signal[idx[idx.length - 1]] <= v) idx.pop();
    idx.push(i);
    while (idx[head] <= i - windowSize) head++;
    out[i] = signal[idx[head]];
  }
  return out;
}

/**
 * Lookahead brick-wall limiter. A `LOOKAHEAD_MS` delay line lets the gain
 * envelope react to peaks before they reach the output: the gain applied to
 * `in[i - L]` is derived from the max of `|in|` over the window `[i-L, i]`,
 * i.e. it already "sees" `L` samples into that delayed sample's future.
 * Gain smoothing is instant-attack (snap down immediately when the target
 * gain drops) / one-pole release (climb back toward 1 over `releaseMs`). A
 * final hard clamp to +/-ceiling is applied as an unconditional safety net.
 * The first `LOOKAHEAD_MS` of output come from the delay line's zero-fill.
 */
export const limiterEffect: EffectDefinition = {
  id: 'limiter',
  name: 'Limiter',
  category: 'Dynamics',
  params: [
    { id: 'ceilingDb', label: 'Ceiling', type: 'number', min: -20, max: 0, step: 0.1, unit: 'dB', default: -0.3 },
    { id: 'releaseMs', label: 'Release', type: 'number', min: 10, max: 1000, step: 1, unit: 'ms', default: 50 },
  ],
  process(channels, sampleRate, params, onProgress) {
    const ceilingDb = Number(params.ceilingDb ?? -0.3);
    const releaseMs = Number(params.releaseMs ?? 50);
    const ceilLin = Math.pow(10, ceilingDb / 20);
    const lookaheadSamples = Math.max(1, Math.round((LOOKAHEAD_MS / 1000) * sampleRate));

    const length = channels[0]?.length ?? 0;
    const detector = maxAcrossChannels(channels);
    const windowMax = slidingWindowMax(detector, lookaheadSamples + 1);

    const releaseCoef = Math.exp(-1 / ((releaseMs / 1000) * sampleRate));
    const gainEnv = new Float32Array(length);
    let gain = 1;
    for (let i = 0; i < length; i++) {
      const raw = windowMax[i] > 1e-9 ? Math.min(1, ceilLin / windowMax[i]) : 1;
      gain = raw < gain ? raw : releaseCoef * gain + (1 - releaseCoef) * raw;
      gainEnv[i] = gain;
    }

    const out = channels.map((c) => new Float32Array(c.length));
    for (let i = 0; i < length; i++) {
      const gain = gainEnv[i];
      for (let ch = 0; ch < channels.length; ch++) {
        const delayed = i >= lookaheadSamples ? channels[ch][i - lookaheadSamples] : 0;
        let v = delayed * gain;
        if (v > ceilLin) v = ceilLin;
        else if (v < -ceilLin) v = -ceilLin;
        out[ch][i] = v;
      }
      maybeReportProgress(onProgress, i, length);
    }

    return { channels: out };
  },
};
