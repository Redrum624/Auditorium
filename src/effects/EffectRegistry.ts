import type { EffectDefinition } from './types';

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

/** All registered effects, sorted by category (alphabetical) then name. */
export function getAllEffects(): EffectDefinition[] {
  return [...registry.values()].sort((a, b) => {
    if (a.category !== b.category) return a.category < b.category ? -1 : 1;
    if (a.name !== b.name) return a.name < b.name ? -1 : 1;
    return 0;
  });
}
