import type { EffectDefinition } from '../types';
import { timeStretchLinked } from '../../dsp/wsola';
import { resampleChannel } from '../../dsp/resample';

/**
 * Pitch Shift — transposes pitch by `semitones` (−24..+24) while preserving duration.
 *
 * Two-stage approach: `f = 2^(semitones/12)` is the linear frequency factor. First
 * a stereo-linked WSOLA time-stretch by `f` (longer/shorter, same pitch, one shared
 * similarity search across channels), then a playback-rate resample by `f`
 * (resampleChannel from sampleRate*f back to sampleRate, i.e. length × 1/f) restores
 * the original duration AND scales every frequency by `f`. Net: pitch × f, duration
 * ≈ unchanged. 0 semitones is a no-op (exact copy). Because the WSOLA stage links the
 * channels, the inter-channel phase relationship is preserved across the shift.
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
    // Stage 1 (shared search) occupies the first half of the progress budget; stage 2
    // (per-channel resample) fills the second half, split evenly across channels.
    const stretched = timeStretchLinked(channels, sampleRate, f, (fr) => onProgress?.(0.5 * fr));
    const out = stretched.map((c, ch) =>
      resampleChannel(c, sampleRate * f, sampleRate, (fr) => onProgress?.(0.5 + (ch + fr) / (2 * numCh)))
    );
    onProgress?.(1);
    return { channels: out };
  },
};
