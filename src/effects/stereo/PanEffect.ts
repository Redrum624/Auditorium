import type { EffectDefinition } from '../types';

/**
 * Constant-power pan applied as per-channel gains to an existing stereo signal.
 * With θ = (pan + 100) / 200 * π/2 mapping pan ∈ [-100, 100] onto [0, π/2]:
 *   L *= cos(θ)   R *= sin(θ)
 * At pan -100 (θ=0) the left channel is untouched and the right is silenced; at
 * pan +100 (θ=π/2) the reverse; at pan 0 both are scaled by cos(π/4) ≈ 0.707.
 * Mono documents have a single channel and no L/R balance, so they pass through
 * as an unchanged copy.
 */
export const panEffect: EffectDefinition = {
  id: 'pan',
  name: 'Pan',
  category: 'Stereo',
  params: [
    { id: 'pan', label: 'Pan', type: 'number', min: -100, max: 100, step: 1, default: 0 },
  ],
  process(channels, _sampleRate, params, onProgress) {
    if (channels.length < 2) {
      onProgress?.(1);
      return { channels: channels.map((c) => Float32Array.from(c)) };
    }

    const pan = Number(params.pan ?? 0);
    const theta = ((pan + 100) / 200) * (Math.PI / 2);
    const gainL = Math.cos(theta);
    const gainR = Math.sin(theta);

    const [L, R] = channels;
    const n = L.length;
    const newL = new Float32Array(n);
    const newR = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      newL[i] = L[i] * gainL;
      newR[i] = R[i] * gainR;
    }
    onProgress?.(1);
    return { channels: [newL, newR] };
  },
};
