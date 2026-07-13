import type { EffectDefinition } from '../types';

/**
 * Stereo channel matrix mixer. Each output channel is a percentage blend of the
 * two input channels:
 *   newL = (llGain*L + lrGain*R) / 100
 *   newR = (rlGain*L + rrGain*R) / 100
 * Gains are percentages in [-200, 200]. The identity preset is 100/0/0/100; the
 * swap preset is 0/100/100/0. Mono documents have no second channel to mix, so
 * they are returned as an unchanged copy.
 */
export const channelMixerEffect: EffectDefinition = {
  id: 'channel-mixer',
  name: 'Channel Mixer',
  category: 'Stereo',
  params: [
    { id: 'llGain', label: 'L -> L', type: 'number', min: -200, max: 200, step: 1, unit: '%', default: 100 },
    { id: 'lrGain', label: 'R -> L', type: 'number', min: -200, max: 200, step: 1, unit: '%', default: 0 },
    { id: 'rlGain', label: 'L -> R', type: 'number', min: -200, max: 200, step: 1, unit: '%', default: 0 },
    { id: 'rrGain', label: 'R -> R', type: 'number', min: -200, max: 200, step: 1, unit: '%', default: 100 },
  ],
  process(channels, _sampleRate, params, onProgress) {
    if (channels.length < 2) {
      onProgress?.(1);
      return { channels: channels.map((c) => Float32Array.from(c)) };
    }

    const ll = Number(params.llGain ?? 100) / 100;
    const lr = Number(params.lrGain ?? 0) / 100;
    const rl = Number(params.rlGain ?? 0) / 100;
    const rr = Number(params.rrGain ?? 100) / 100;

    const [L, R] = channels;
    const n = L.length;
    const newL = new Float32Array(n);
    const newR = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const l = L[i];
      const r = R[i];
      newL[i] = ll * l + lr * r;
      newR[i] = rl * l + rr * r;
    }
    onProgress?.(1);
    return { channels: [newL, newR] };
  },
};
