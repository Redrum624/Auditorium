import type { EffectDefinition } from '../types';
import { maybeReportProgress } from '../dynamics/envelope';

const BASE_DELAY_MS = 1;

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
 * Flanger: a single modulated short delay line WITH feedback (unlike
 * chorus). The delay line is its own running buffer `line[i] = in[i] +
 * feedback * tap`, where `tap` is a linearly-interpolated fractional read of
 * `line` at `i - delay` — the same comb-filter shape as `Comb` in
 * ReverbEffect, but with a time-varying (not fixed) delay. `tap` is the wet
 * sample; final output mixes it with the dry input.
 *
 * The delay sweeps `BASE_DELAY_MS .. BASE_DELAY_MS + depthMs` on a UNIPOLAR
 * sine LFO (`(1+sin)/2`, range [0,1]) rather than a bipolar +/- sweep like
 * chorus: with a 1ms base and depth up to 5ms, a bipolar sweep would go
 * negative. Output length always equals input length (no tail).
 */
export const flangerEffect: EffectDefinition = {
  id: 'flanger',
  name: 'Flanger',
  category: 'Modulation',
  params: [
    { id: 'rateHz', label: 'Rate', type: 'number', min: 0.05, max: 2, step: 0.01, unit: 'Hz', default: 0.25 },
    { id: 'depthMs', label: 'Depth', type: 'number', min: 0.5, max: 5, step: 0.1, unit: 'ms', default: 2 },
    { id: 'feedback', label: 'Feedback', type: 'number', min: 0, max: 0.9, step: 0.01, default: 0.5 },
    { id: 'mix', label: 'Mix', type: 'number', min: 0, max: 1, step: 0.01, default: 0.5 },
  ],
  process(channels, sampleRate, params, onProgress) {
    const rateHz = Number(params.rateHz ?? 0.25);
    const depthMs = Number(params.depthMs ?? 2);
    const feedback = Number(params.feedback ?? 0.5);
    const mix = Number(params.mix ?? 0.5);

    const baseDelaySamples = (BASE_DELAY_MS / 1000) * sampleRate;
    const depthSamples = (depthMs / 1000) * sampleRate;
    const N = channels[0]?.length ?? 0;
    const numCh = channels.length;
    const totalSamples = N * numCh;
    let processed = 0;

    const out: Float32Array[] = [];
    for (let ch = 0; ch < numCh; ch++) {
      const src = channels[ch];
      const line = new Float32Array(N); // running delay-line buffer (feedback path)
      const dst = new Float32Array(N);
      for (let i = 0; i < N; i++) {
        const lfo = (1 + Math.sin((2 * Math.PI * rateHz * i) / sampleRate)) / 2;
        const delay = baseDelaySamples + depthSamples * lfo;
        const tap = readInterp(line, i - delay);
        line[i] = src[i] + feedback * tap;
        dst[i] = src[i] * (1 - mix) + tap * mix;
        processed++;
        maybeReportProgress(onProgress, processed - 1, totalSamples);
      }
      out.push(dst);
    }

    return { channels: out };
  },
};
