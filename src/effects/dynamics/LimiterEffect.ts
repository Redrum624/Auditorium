import type { EffectDefinition } from '../types';
import { maxAcrossChannels, maybeReportProgress } from './envelope';

const LOOKAHEAD_MS = 5; // fixed, not a user param

/** Compact the deque's consumed prefix once the head pointer grows past this,
 * bounding memory to O(window + threshold) instead of O(n) for long signals. */
const DEQUE_COMPACT_THRESHOLD = 4096;

/**
 * Forward-looking sliding-window max: `out[i] = max(signal[i .. min(i +
 * lookahead, length-1)])` — the window covers the current sample plus the
 * next `lookahead` samples and shrinks naturally at the tail. Computed in
 * O(n) via a monotonic deque of indices (values decreasing front-to-back).
 * A plain head index avoids `Array.shift()`'s O(n) reindexing; the consumed
 * prefix is periodically sliced off to keep the deque's memory bounded.
 */
function forwardWindowMax(signal: Float32Array, lookahead: number): Float32Array {
  const length = signal.length;
  const out = new Float32Array(length);
  const idx: number[] = [];
  let head = 0;
  let next = 0; // next index to feed into the deque
  for (let i = 0; i < length; i++) {
    const end = Math.min(i + lookahead, length - 1);
    while (next <= end) {
      const v = signal[next];
      while (idx.length > head && signal[idx[idx.length - 1]] <= v) idx.pop();
      idx.push(next);
      next++;
    }
    while (idx[head] < i) head++;
    if (head > DEQUE_COMPACT_THRESHOLD) {
      idx.splice(0, head);
      head = 0;
    }
    out[i] = signal[idx[head]];
  }
  return out;
}

/**
 * Lookahead brick-wall limiter with forward-looking alignment: `out[i] =
 * in[i] * g[i]`, where `g[i]` is derived from the max of the detector over
 * the FUTURE window `in[i .. i+L]` (`L` = `LOOKAHEAD_MS` of samples; the
 * window shrinks naturally at the tail). Because the gain envelope sees `L`
 * samples ahead, it snaps down before a peak arrives — with no delay line,
 * so the output stays sample-aligned with the input, nothing is dropped at
 * the tail, and there is no zero pre-roll at the head. Gain smoothing is
 * instant-attack (take the min immediately when the target gain drops) /
 * one-pole release (climb back toward 1 over `releaseMs`). A final hard
 * clamp to +/-ceiling is applied as an unconditional safety net. Output
 * length always equals input length.
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
    const windowMax = forwardWindowMax(detector, lookaheadSamples);

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
      const g = gainEnv[i];
      for (let ch = 0; ch < channels.length; ch++) {
        let v = channels[ch][i] * g;
        if (v > ceilLin) v = ceilLin;
        else if (v < -ceilLin) v = -ceilLin;
        out[ch][i] = v;
      }
      maybeReportProgress(onProgress, i, length);
    }

    return { channels: out };
  },
};
