import { registerEffect } from './EffectRegistry';
import { amplifyEffect } from './basic/AmplifyEffect';
import { normalizeEffect } from './basic/NormalizeEffect';
import { fadeEffect } from './basic/FadeEffect';
import { reverseEffect } from './basic/ReverseEffect';
import { invertEffect } from './basic/InvertEffect';
import { dcRemoveEffect } from './basic/DcRemoveEffect';

let registered = false;

/**
 * Registers every built-in effect into the module-level registry. Idempotent —
 * a guard flag makes repeat calls no-ops, so both `App.tsx` and `dsp.worker.ts`
 * can import and call this safely without triggering a duplicate-id throw.
 */
export function registerAllEffects(): void {
  if (registered) return;
  registered = true;
  registerEffect(amplifyEffect);
  registerEffect(normalizeEffect);
  registerEffect(fadeEffect);
  registerEffect(reverseEffect);
  registerEffect(invertEffect);
  registerEffect(dcRemoveEffect);
}
