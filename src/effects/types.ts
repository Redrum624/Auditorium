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

/**
 * Optional (F7): flat, display-oriented facts an effect knows about its own run
 * that a CALLER CANNOT MEASURE from the before/after buffers.
 *
 * The bar is deliberately high, because almost everything is measurable from
 * outside: level change, peak change, how many samples moved, the RMS of what
 * was removed — the Vocal Chain computes all of those itself for every stage
 * (`measureStageDelta`). What it cannot recover is a quantity that exists only
 * as an intermediate inside `process`: Pitch Correct's correction curve is the
 * shipped example — the cents it applied are gone by the time the resynthesized
 * audio comes back, and re-deriving them means running the pitch detector a
 * second time, which measured 282 ms per audio-second.
 *
 * Rides back through the worker beside `removedSpans`, for the same reason and
 * on the same shared message type.
 */
export type EffectReport = Record<string, number | string>;

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
  /** Optional (F7) — see `EffectReport`. Display only: nothing in the audio
   * path may read it, so an effect that omits it behaves identically. */
  report?: EffectReport;
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
   * F9: keep this effect OUT of the Effects menu and the effects browser.
   *
   * An effect is normally a self-contained transform of the selection plus a
   * few scalar params, which is exactly what the generic `EffectDialog` can
   * drive. A hidden one cannot be driven that way — its essential input arrives
   * through the `__effectExtra` side channel from its own dialog (Align Vocal
   * Timing needs a confirmed anchor list), so offering it in the generic list
   * would present a control that opens a params-only dialog and then refuses.
   * It is still fully registered, so the worker can run it and `getEffect`
   * finds it; only `getVisibleEffects` filters it out.
   */
  hidden?: boolean;
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
