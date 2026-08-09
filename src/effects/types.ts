// Canonical effect contracts (Shared Contracts, Task 13). Later effect tasks
// (14-19) depend on these names — do not rename.

export type EffectParamValue = number | string | boolean;

/** What a `readout` gets to see besides the param's own value (v1.9.2, R2-2).
 * `regionSamples` is the length of the region the effect will actually target:
 * the active selection, or the WHOLE document when there is none — the same
 * fallback `runEffectOnSelection` applies (trap T11: a selection-only readout
 * would show 0 for the most common whole-file apply). */
export interface EffectReadoutContext {
  regionSamples: number;
  sampleRate: number;
}

export interface EffectParamDef {
  id: string;
  label: string;
  type: 'number' | 'select' | 'boolean';
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  options?: { value: string; label: string }[];
  default: EffectParamValue;
  /** Optional DISPLAY-ONLY derived readout (v1.9.2, R2-2): maps the current
   * value + the target region to a string rendered beside the control (e.g.
   * Fade's `lengthPercent` showing the ramp in absolute time). Pure; must
   * mirror the effect's own arithmetic (clamps, rounding) so the number shown
   * is the number written. It never feeds back into the stored value. */
  readout?: (value: EffectParamValue, ctx: EffectReadoutContext) => string;
}

export interface EffectResult {
  channels: Float32Array[]; // may differ in length (time-stretch)
  /** Optional (F2): a length-changing effect that DELETES discontiguous
   * interior spans (Remove Silence) lists here the exact INPUT-relative
   * `[start, end)` sample spans absent from the output — sorted ascending,
   * non-overlapping, with lengths summing to `inputLen - outputLen`.
   * effectRunner then remaps markers with the exact piecewise 'cuts' rule
   * instead of the proportional 'stretch' heuristic, which mis-places every
   * marker after a removed gap. Absent for all other effects. */
  removedSpans?: { start: number; end: number }[];
}

export type EffectCategory =
  | 'Amplitude'
  | 'EQ & Filters'
  | 'Dynamics'
  | 'Delay & Reverb'
  | 'Modulation'
  | 'Distortion'
  | 'Restoration'
  | 'Stereo'
  | 'Time & Pitch'
  | 'Utility';

export interface EffectDefinition {
  id: string; // kebab-case: 'amplify', 'parametric-eq', ...
  name: string; // menu label: 'Amplify'
  category: EffectCategory;
  params: EffectParamDef[];
  /**
   * Pure & synchronous — the worker provides the async boundary. MUST NOT mutate
   * the input channel arrays; always allocate new Float32Arrays for the result.
   */
  process(
    channels: Float32Array[],
    sampleRate: number,
    params: Record<string, EffectParamValue>,
    onProgress?: (fraction: number) => void
  ): EffectResult;
}
