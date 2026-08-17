import type { EffectDefinition } from '../types';
import type { FadeCurve } from '../../dsp/fades';
import { FADE_CURVE_LABELS, fadeInGainAt, fadeOutGainAt } from '../../dsp/fades';
import { formatTime } from '../../utils/timeFormat';

/**
 * Amplitude envelope over the leading (fade-in) or trailing (fade-out) part
 * of the selection. Destructive by design (ruling 3): it edits samples, unlike
 * the non-destructive clip fades of the multitrack view (X2-X4).
 *
 * The curve math comes from the shared family in `src/dsp/fades.ts` (X6);
 * this effect's persisted curve ids predate that module and are MAPPED onto
 * it rather than renamed, because the ids live in saved presets and undo
 * history: `linear` -> `equal-gain`, `exponential` -> `exponential`,
 * `cosine` -> `smooth`, plus the new `equal-power` (ruling 2). The mapping is
 * behaviour-preserving for the three v1.8.0 curves -- `fades.ts` transcribed
 * their shapes verbatim, and `fadeEffect.golden.test.ts` pins every rendered
 * sample byte-for-byte across the change.
 *
 * `lengthPercent` sets how much of the selection the ramp occupies (100 = the
 * whole selection, exactly the v1.8.0 behaviour and the default). A fade-in
 * shapes the FIRST `round(length * pct / 100)` samples, a fade-out the LAST;
 * everything outside the ramp is left byte-identical. The percentage is
 * clamped to [0, 100], so the ramp can never outrun the selection. One-sample
 * ramps keep the v1.8.0 singleton conventions: a fade-in zeroes the sample
 * (its ramp position is t = 0), a fade-out leaves it (gain 1) -- a one-sample
 * "trail-off" must not delete a legitimate final sample.
 */

/** Persisted curve id -> shared `fades.ts` curve. Keys are the option values
 * below; an unknown id falls back to `equal-gain`, which is what the v1.8.0
 * switch's `default:` branch did (it rendered the linear ramp). */
const CURVE_BY_PARAM: Record<string, FadeCurve | undefined> = {
  linear: 'equal-gain',
  exponential: 'exponential',
  cosine: 'smooth',
  'equal-power': 'equal-power',
};

export const fadeEffect: EffectDefinition = {
  id: 'fade',
  name: 'Fade',
  category: 'Amplitude',
  params: [
    {
      id: 'direction',
      label: 'Direction',
      type: 'select',
      options: [
        { value: 'in', label: 'Fade In' },
        { value: 'out', label: 'Fade Out' },
      ],
      default: 'in',
    },
    {
      id: 'curve',
      label: 'Curve',
      type: 'select',
      options: [
        // Values are persisted in presets and undo history -- never change
        // them. Labels are the UI's to choose: `exponential` shows the same
        // 'Ducked' the clip-fade picker shows (X4, ruling 2 -- the t^2 shape
        // is quadratic, so "Exponential" was wrong twice over), and the new
        // constant-power option shares the clip picker's 'Equal power'.
        { value: 'linear', label: 'Linear' },
        { value: 'exponential', label: FADE_CURVE_LABELS.exponential },
        { value: 'cosine', label: 'Cosine' },
        { value: 'equal-power', label: FADE_CURVE_LABELS['equal-power'] },
      ],
      default: 'linear',
    },
    {
      id: 'lengthPercent',
      label: 'Length',
      type: 'number',
      min: 0,
      max: 100,
      step: 1,
      unit: '% of selection',
      default: 100,
      // v1.9.2 (R2-2): absolute-time readout — 50% of a 3 s selection is very
      // different from 50% of 30 s. Mirrors `process` EXACTLY (same clamp,
      // same `Math.round`, same selection length via ctx.regionSamples — trap
      // T10: an unrounded readout disagrees with what is written on short
      // selections, precisely where a user checks the number). `≈` because
      // `formatTime` then rounds the exact sample count to milliseconds.
      // Assumes a SEEDED value (EffectDialog seeds params from defaults);
      // an undefined value would render NaN -- do not wire to unseeded paths.
      readout: (value, ctx) => {
        const pct = Math.max(0, Math.min(100, Number(value)));
        const fadeLen = Math.round((ctx.regionSamples * pct) / 100);
        return `≈ ${formatTime(fadeLen, ctx.sampleRate)}`;
      },
    },
  ],
  process(channels, _sampleRate, params, onProgress) {
    const direction = String(params.direction ?? 'in');
    const curve = CURVE_BY_PARAM[String(params.curve ?? 'linear')] ?? 'equal-gain';
    const selLen = channels[0]?.length ?? 0;
    // Single clamp point: with pct in [0, 100], fadeLen is in [0, selLen] by
    // construction, so no second defensive clamp exists to mask this one.
    const pct = Math.max(0, Math.min(100, Number(params.lengthPercent ?? 100)));
    const fadeLen = Math.round((selLen * pct) / 100);

    const out = channels.map((c) => {
      const dst = new Float32Array(c);
      const start = direction === 'out' ? dst.length - fadeLen : 0;
      for (let j = 0; j < fadeLen; j++) {
        const g =
          direction === 'out'
            ? fadeOutGainAt(j, fadeLen, curve, 1)
            : fadeInGainAt(j, fadeLen, curve, 0);
        dst[start + j] = c[start + j] * g;
      }
      return dst;
    });
    channels.forEach((_, i) => onProgress?.((i + 1) / channels.length));
    return { channels: out };
  },
};
