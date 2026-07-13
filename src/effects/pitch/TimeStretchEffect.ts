import type { EffectDefinition } from '../types';
import { timeStretch } from '../../dsp/wsola';

/**
 * Time Stretch — changes duration while preserving pitch (WSOLA). `stretchPercent`
 * is the output length as a percentage of the input: 200 makes the audio twice as
 * long (half speed), 50 makes it half as long, both with the pitch unchanged.
 * 100% is a no-op (exact copy). Stereo channels are stretched independently — with
 * identical length inputs they map to identical output lengths, so channels stay
 * aligned (see the stereo phase caveat in docs/KNOWN_LIMITATIONS.md).
 */
export const timeStretchEffect: EffectDefinition = {
  id: 'time-stretch',
  name: 'Time Stretch',
  category: 'Time & Pitch',
  params: [
    { id: 'stretchPercent', label: 'Stretch', type: 'number', min: 25, max: 400, step: 1, unit: '%', default: 100 },
  ],
  process(channels, sampleRate, params, onProgress) {
    const percent = Number(params.stretchPercent ?? 100);
    if (percent === 100) {
      onProgress?.(1);
      return { channels: channels.map((c) => Float32Array.from(c)) };
    }

    const ratio = percent / 100;
    const numCh = channels.length;
    const out = channels.map((c, ch) =>
      timeStretch(c, sampleRate, ratio, (f) => onProgress?.((ch + f) / numCh))
    );
    onProgress?.(1);
    return { channels: out };
  },
};
