// Canonical effect contracts (Shared Contracts, Task 13). Later effect tasks
// (14-19) depend on these names — do not rename.

export type EffectParamValue = number | string | boolean;

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
}

export interface EffectResult {
  channels: Float32Array[];
} // may differ in length (time-stretch)

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
