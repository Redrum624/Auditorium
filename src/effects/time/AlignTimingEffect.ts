/**
 * Task F9 — the Align Vocal Timing effect.
 *
 * A thin worker-side wrapper over `timingWarp.ts`: it exists so the warp runs
 * off the UI thread through the ordinary `runEffectOnSelection` path (progress,
 * `applyEdit`, undo, marker remap) rather than needing a bespoke worker.
 *
 * **It is `hidden`.** Every other effect is a self-contained transform of the
 * selected samples plus a few scalar params, so the generic `EffectDialog` can
 * drive it. This one cannot be: its essential input is a LIST OF CONFIRMED
 * ANCHORS, which only `AlignTimingDialog` can produce — the user has to see the
 * beat grid, choose the subdivision and confirm the moves first (RULING 1, and
 * `timingWarp.ts`'s measured onset reliability). Listing it among the EFFECTS
 * would offer a control that opens a params-only dialog and then refuses,
 * because there would be no anchors. `Pipeline -> Align Vocal Timing` is
 * registered separately as a command that opens the real dialog.
 *
 * Anchors arrive REGION-RELATIVE through the `__effectExtra` side channel (the
 * same channel Noise Reduction's noise print uses), because that is the only
 * way to get a non-scalar payload to `process`.
 */

import { applyTimingWarp, DEFAULT_STRENGTH, type TimingAnchor } from '../../dsp/timingWarp';
import type { EffectDefinition, EffectParamValue } from '../types';

/** The `__effectExtra` payload. Region-relative sample positions. */
export interface AlignTimingExtra {
  anchors: TimingAnchor[];
}

export const ALIGN_TIMING_EFFECT_ID = 'align-timing';

function readAnchors(): TimingAnchor[] {
  const extra = (globalThis as { __effectExtra?: AlignTimingExtra }).__effectExtra;
  const anchors = extra?.anchors;
  if (!Array.isArray(anchors) || anchors.length === 0) {
    // Thrown, not swallowed: `effectRunner` surfaces it as an error dialog and
    // applies no edit. Returning the input unchanged would push an undo entry
    // that did nothing and look like the feature silently failing.
    throw new Error(
      'Align Vocal Timing needs confirmed anchors. Open Pipeline → Align Vocal Timing rather than running this effect directly.'
    );
  }
  return anchors;
}

export const alignTimingEffect: EffectDefinition = {
  id: ALIGN_TIMING_EFFECT_ID,
  name: 'Align Vocal Timing',
  category: 'Time & Pitch',
  hidden: true,
  params: [
    {
      id: 'strengthPercent',
      label: 'Strength',
      type: 'number',
      min: 0,
      max: 100,
      step: 1,
      unit: '%',
      default: Math.round(DEFAULT_STRENGTH * 100),
    },
  ],
  process(
    channels: Float32Array[],
    sampleRate: number,
    params: Record<string, EffectParamValue>,
    onProgress?: (fraction: number) => void
  ) {
    const anchors = readAnchors();
    const raw = Number(params.strengthPercent);
    const strength = Number.isFinite(raw) ? raw / 100 : DEFAULT_STRENGTH;
    const { channels: out } = applyTimingWarp(channels, sampleRate, anchors, { strength }, onProgress);
    // No `removedSpans`: the warp deletes nothing, and its output length always
    // equals its input length, so `effectRunner`'s proportional 'stretch' marker
    // remap is a no-op — markers keep their positions, which is what the user
    // placed them for.
    return { channels: out };
  },
};
