import type { EffectDefinition } from '../types';
import { timeStretch } from '../../dsp/wsola';
import { resampleChannel } from '../../dsp/resample';

/**
 * Pitch Shift — transposes pitch by `semitones` (−24..+24) while preserving duration.
 *
 * Two-stage approach: `f = 2^(semitones/12)` is the linear frequency factor. First
 * WSOLA time-stretches the channel by `f` (longer/shorter, same pitch), then a
 * playback-rate resample by `f` (resampleChannel from sampleRate*f back to sampleRate,
 * i.e. length × 1/f) restores the original duration AND scales every frequency by `f`.
 * Net: pitch × f, duration ≈ unchanged. 0 semitones is a no-op (exact copy).
 *
 * Stereo channels are processed independently — acceptable for v1; the inter-channel
 * phase relationship is not preserved across the shift (see docs/KNOWN_LIMITATIONS.md).
 */
export const pitchShiftEffect: EffectDefinition = {
  id: 'pitch-shift',
  name: 'Pitch Shift',
  category: 'Time & Pitch',
  params: [
    { id: 'semitones', label: 'Semitones', type: 'number', min: -24, max: 24, step: 0.1, unit: 'st', default: 0 },
  ],
  process(channels, sampleRate, params, onProgress) {
    const semitones = Number(params.semitones ?? 0);
    if (semitones === 0) {
      onProgress?.(1);
      return { channels: channels.map((c) => Float32Array.from(c)) };
    }

    const f = Math.pow(2, semitones / 12);
    const numCh = channels.length;
    const out = channels.map((c, ch) => {
      // Each channel spans two half-progress sub-steps: stretch, then resample.
      const stretched = timeStretch(c, sampleRate, f, (fr) => onProgress?.((ch + 0.5 * fr) / numCh));
      return resampleChannel(stretched, sampleRate * f, sampleRate, (fr) =>
        onProgress?.((ch + 0.5 + 0.5 * fr) / numCh)
      );
    });
    onProgress?.(1);
    return { channels: out };
  },
};
