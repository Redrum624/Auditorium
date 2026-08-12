import type { EffectDefinition, EffectParamValue } from './types';

/** Module-level registry keyed by effect id. Populated by `registerAll.ts`, which
 * both the app (`App.tsx`) and the dsp worker import. */
const registry = new Map<string, EffectDefinition>();

/** Registers an effect. Throws if the id is already taken. */
export function registerEffect(def: EffectDefinition): void {
  if (registry.has(def.id)) {
    throw new Error(`Effect already registered: ${def.id}`);
  }
  registry.set(def.id, def);
}

export function getEffect(id: string): EffectDefinition | undefined {
  return registry.get(id);
}

/** All registered effects, sorted by category (alphabetical) then name.
 * INCLUDES `hidden` ones — this is the registry's own inventory. Anything
 * building a user-facing list wants {@link getVisibleEffects} instead. */
export function getAllEffects(): EffectDefinition[] {
  return [...registry.values()].sort((a, b) => {
    if (a.category !== b.category) return a.category < b.category ? -1 : 1;
    if (a.name !== b.name) return a.name < b.name ? -1 : 1;
    return 0;
  });
}

/**
 * The effects a user can pick from a menu or a browser list: {@link
 * getAllEffects} minus the `hidden` ones (F9). Every user-facing surface must
 * use this — a hidden effect has no usable generic dialog, so listing it offers
 * a control that cannot work. See `EffectDefinition.hidden`.
 */
export function getVisibleEffects(): EffectDefinition[] {
  return getAllEffects().filter((e) => !e.hidden);
}

/**
 * Every declared default for one effect, as the params record `process` takes.
 * Throws on an unknown id rather than returning `{}`, because an empty record
 * silently means "every default" to `process` and would hide the typo.
 *
 * F7 uses this as the Vocal Chain's starting point for EVERY stage: the chain
 * does not restate any effect's defaults, it inherits them and overrides ONLY
 * the ones whose derivation the chain context provably changes. FIVE effects
 * get one — the de-esser's threshold (per F8's Ruling 1), the compressor's
 * threshold and makeup, Remove Silence's threshold, DeHum's base frequency and
 * the EQ's high-pass corner — and every overridden value is measured from the
 * audio reaching that stage. Everything else, including the limiter's ceiling,
 * runs on what the effect itself declared. That way a default re-derived in the
 * effect reaches the chain automatically, and there is no second copy to drift.
 * The full argument, stage by stage, is at the top of `services/vocalChain.ts`.
 */
export function defaultParamsFor(id: string): Record<string, EffectParamValue> {
  const def = registry.get(id);
  if (!def) throw new Error(`Unknown effect: ${id}`);
  const params: Record<string, EffectParamValue> = {};
  for (const p of def.params) params[p.id] = p.default;
  return params;
}
