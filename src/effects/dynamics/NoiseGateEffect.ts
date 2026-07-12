import type { EffectDefinition } from '../types';
import { envelopeFollower, maxAcrossChannels, maybeReportProgress } from './envelope';

type GateState = 'open' | 'holding' | 'closing' | 'closed';

const FADE_FLOOR_DB = -80;

/**
 * Noise gate. Detector = envelope follower (attackMs/releaseMs) of
 * max(|L|,|R|). An explicit per-sample state machine drives the gate gain
 * (applied identically to every channel):
 * - `open`: envDb > threshold. Gain = 1 (0dB). Reopening from any other
 *   state is instant (attack-fast) — the very sample envDb crosses back
 *   above threshold snaps straight to `open`/gain=1.
 * - `holding`: envDb dropped below threshold; gain stays at 1 for `holdMs`.
 * - `closing`: after the hold expires, gain fades linear-in-dB from 0dB down
 *   to `FADE_FLOOR_DB` over `releaseMs`.
 * - `closed`: fade complete; gain is hard 0.
 */
export const noiseGateEffect: EffectDefinition = {
  id: 'noise-gate',
  name: 'Noise Gate',
  category: 'Dynamics',
  params: [
    { id: 'thresholdDb', label: 'Threshold', type: 'number', min: -80, max: 0, step: 0.1, unit: 'dB', default: -50 },
    { id: 'attackMs', label: 'Attack', type: 'number', min: 0.1, max: 50, step: 0.1, unit: 'ms', default: 1 },
    { id: 'releaseMs', label: 'Release', type: 'number', min: 10, max: 2000, step: 1, unit: 'ms', default: 150 },
    { id: 'holdMs', label: 'Hold', type: 'number', min: 0, max: 500, step: 1, unit: 'ms', default: 50 },
  ],
  process(channels, sampleRate, params, onProgress) {
    const thresholdDb = Number(params.thresholdDb ?? -50);
    const attackMs = Number(params.attackMs ?? 1);
    const releaseMs = Number(params.releaseMs ?? 150);
    const holdMs = Number(params.holdMs ?? 50);

    const holdSamples = Math.round((holdMs / 1000) * sampleRate);
    const releaseSamples = Math.max(1, Math.round((releaseMs / 1000) * sampleRate));

    const length = channels[0]?.length ?? 0;
    const detector = maxAcrossChannels(channels);
    const env = envelopeFollower(detector, sampleRate, attackMs, releaseMs);

    const out = channels.map((c) => new Float32Array(c.length));
    let state: GateState = 'closed';
    let holdRemaining = 0;
    let fadeElapsed = 0;

    for (let i = 0; i < length; i++) {
      const envDb = 20 * Math.log10(Math.max(env[i], 1e-6));
      const above = envDb > thresholdDb;

      if (above) {
        state = 'open';
      } else if (state === 'open') {
        state = 'holding';
        holdRemaining = holdSamples;
      } else if (state === 'holding') {
        holdRemaining--;
        if (holdRemaining <= 0) {
          state = 'closing';
          fadeElapsed = 0;
        }
      } else if (state === 'closing') {
        fadeElapsed++;
        if (fadeElapsed >= releaseSamples) state = 'closed';
      }
      // 'closed' with envDb still below threshold: stays closed.

      let gain: number;
      if (state === 'open' || state === 'holding') {
        gain = 1;
      } else if (state === 'closing') {
        const fadeDb = FADE_FLOOR_DB * (fadeElapsed / releaseSamples);
        gain = Math.pow(10, fadeDb / 20);
      } else {
        gain = 0;
      }

      for (let ch = 0; ch < channels.length; ch++) {
        out[ch][i] = channels[ch][i] * gain;
      }
      maybeReportProgress(onProgress, i, length);
    }

    return { channels: out };
  },
};
