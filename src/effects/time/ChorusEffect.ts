import type { EffectDefinition } from '../types';
import { maybeReportProgress } from '../dynamics/envelope';

const BASE_DELAY_MS = 20;

/** Linear-interpolated fractional read of `signal` at `pos` (a real-valued
 * sample index); out-of-range reads (negative, or past the end) return 0. */
function readInterp(signal: Float32Array, pos: number): number {
  const i0 = Math.floor(pos);
  const frac = pos - i0;
  const s0 = i0 >= 0 && i0 < signal.length ? signal[i0] : 0;
  const s1 = i0 + 1 >= 0 && i0 + 1 < signal.length ? signal[i0 + 1] : 0;
  return s0 * (1 - frac) + s1 * frac;
}

/**
 * Chorus: `voices` modulated delay lines read (with linear interpolation)
 * directly from the source signal — no feedback, so each voice is just a
 * time-varying re-read of the input. Each voice's delay sweeps
 * `BASE_DELAY_MS +/- depthMs` on a sine LFO at `rateHz`, phase-spread evenly
 * across voices (`voice k` phase = `k * 2*PI / voices`) so they don't move in
 * lockstep. The wet signal is the average of all voices; output length
 * always equals input length (no tail — the bounded modulated delay never
 * needs one).
 */
export const chorusEffect: EffectDefinition = {
  id: 'chorus',
  name: 'Chorus',
  category: 'Modulation',
  params: [
    { id: 'rateHz', label: 'Rate', type: 'number', min: 0.1, max: 5, step: 0.01, unit: 'Hz', default: 0.8 },
    { id: 'depthMs', label: 'Depth', type: 'number', min: 1, max: 20, step: 0.1, unit: 'ms', default: 7 },
    { id: 'mix', label: 'Mix', type: 'number', min: 0, max: 1, step: 0.01, default: 0.5 },
    {
      id: 'voices',
      label: 'Voices',
      type: 'select',
      options: [
        { value: '2', label: '2' },
        { value: '3', label: '3' },
      ],
      default: '2',
    },
  ],
  process(channels, sampleRate, params, onProgress) {
    const rateHz = Number(params.rateHz ?? 0.8);
    const depthMs = Number(params.depthMs ?? 7);
    const mix = Number(params.mix ?? 0.5);
    const voices = Math.max(2, Math.min(3, Math.round(Number(params.voices ?? 2))));

    const baseDelaySamples = (BASE_DELAY_MS / 1000) * sampleRate;
    const depthSamples = (depthMs / 1000) * sampleRate;
    const N = channels[0]?.length ?? 0;
    const numCh = channels.length;
    const totalSamples = N * numCh;
    let processed = 0;

    const out: Float32Array[] = [];
    for (let ch = 0; ch < numCh; ch++) {
      const src = channels[ch];
      const dst = new Float32Array(N);
      for (let i = 0; i < N; i++) {
        let wetSum = 0;
        for (let v = 0; v < voices; v++) {
          const phase = (v * 2 * Math.PI) / voices;
          const lfo = Math.sin((2 * Math.PI * rateHz * i) / sampleRate + phase);
          const delay = baseDelaySamples + depthSamples * lfo;
          wetSum += readInterp(src, i - delay);
        }
        const wet = wetSum / voices;
        dst[i] = src[i] * (1 - mix) + wet * mix;
        processed++;
        maybeReportProgress(onProgress, processed - 1, totalSamples);
      }
      out.push(dst);
    }

    return { channels: out };
  },
};
