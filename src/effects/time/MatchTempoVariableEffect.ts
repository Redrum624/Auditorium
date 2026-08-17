/**
 * Task R7 — the variable-rate Match Tempo effect.
 *
 * A thin worker-side wrapper over `tempoMap.ts`, exactly in
 * `AlignTimingEffect`'s shape and for the same reason: it exists so the warp
 * runs off the UI thread through the ordinary `runEffectOnSelection` path
 * (progress, `applyEdit`, undo, the length-changing marker remap) rather than
 * needing a bespoke worker.
 *
 * **It is `hidden`.** Its essential input is a CONFIRMED BEAT GRID, which only
 * `TempoDialog` can produce — the user has to see the grid, correct its octave
 * if the detector picked the wrong one, and confirm it (RULING 1). Listing it in
 * the Effects menu would offer a control that opens a params-only dialog and
 * then refuses, because there would be no grid. `Pipeline → Match Tempo` is
 * already registered separately as the command that opens the real dialog.
 *
 * The grid arrives REGION-RELATIVE through the `__effectExtra` side channel —
 * the same channel Noise Reduction's noise print and Align Vocal Timing's
 * anchors use, because that is the only way to get a non-scalar payload to
 * `process`.
 *
 * The map is rebuilt here rather than shipped across the boundary: `buildTempoMap`
 * is pure, so the dialog's preview and this run produce the SAME map from the
 * SAME inputs, and a `TempoMap` full of `Float64Array`s would otherwise have to
 * survive structured cloning intact to stay trustworthy. F9 established the
 * same split for the align plan's clamp preview.
 */

import { applyTempoMap, buildTempoMap } from '../../dsp/tempoMap';
import type { EffectDefinition, EffectParamValue } from '../types';

/** The `__effectExtra` payload. Region-relative sample positions. */
export interface MatchTempoVariableExtra {
  /** Confirmed beat positions, region-relative, ascending. */
  beatSamples: number[];
  /** Target beat spacing in samples — `60 / targetBpm * sampleRate`, NOT
   * rounded. Rounding it would re-introduce up to half a sample of drift per
   * beat, which over a few hundred beats is the accumulating error this effect
   * exists to remove. */
  targetSpacing: number;
}

export const MATCH_TEMPO_VARIABLE_EFFECT_ID = 'match-tempo-variable';

function readExtra(): MatchTempoVariableExtra {
  const extra = (globalThis as { __effectExtra?: MatchTempoVariableExtra }).__effectExtra;
  const beats = extra?.beatSamples;
  const targetSpacing = extra?.targetSpacing;
  if (!Array.isArray(beats) || beats.length < 2 || !Number.isFinite(targetSpacing) || (targetSpacing as number) <= 0) {
    // Thrown, not swallowed: `effectRunner` surfaces it as an error dialog and
    // applies no edit. Returning the input unchanged would push an undo entry
    // that did nothing and look like the feature silently failing.
    throw new Error(
      'Variable-rate Match Tempo needs a confirmed beat grid. Open Pipeline → Match Tempo rather than running this effect directly.'
    );
  }
  return { beatSamples: beats, targetSpacing: targetSpacing as number };
}

export const matchTempoVariableEffect: EffectDefinition = {
  id: MATCH_TEMPO_VARIABLE_EFFECT_ID,
  name: 'Match Tempo (follow the beats)',
  category: 'Time & Pitch',
  hidden: true,
  params: [],
  process(
    channels: Float32Array[],
    sampleRate: number,
    _params: Record<string, EffectParamValue>,
    onProgress?: (fraction: number) => void
  ) {
    const { beatSamples, targetSpacing } = readExtra();
    const map = buildTempoMap(beatSamples, channels[0]?.length ?? 0, targetSpacing);
    const out = applyTempoMap(channels, sampleRate, map, onProgress);
    // No `removedSpans`: the map deletes nothing. The region's LENGTH does
    // change, so `effectRunner`'s proportional 'stretch' remap applies — which
    // is an approximation for a variable-rate map (it is exact only where the
    // local ratio equals the region's average). `tempoService` therefore does
    // not rely on it: it lays the beat grid from `map.placed`, and (v1.23.1)
    // recomputes every PRE-EXISTING marker from its pre-run position through
    // this same map afterwards, as its own undo entry. Both corrections live in
    // the service because the shared remap has already committed by then; the
    // reasoning is recorded in docs/KNOWN_LIMITATIONS.md.
    return { channels: out };
  },
};
