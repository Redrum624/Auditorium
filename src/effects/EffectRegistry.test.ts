import type { EffectDefinition, EffectCategory } from './types';

// Each `it` re-requires the registry module so the module-level Map starts empty
// (jest.resetModules clears the CommonJS cache under ts-jest).
type RegistryModule = typeof import('./EffectRegistry');

function makeDef(
  id: string,
  name: string,
  category: EffectCategory
): EffectDefinition {
  return {
    id,
    name,
    category,
    params: [],
    process: (channels) => ({ channels: channels.map((c) => c.slice()) }),
  };
}

describe('EffectRegistry', () => {
  let reg: RegistryModule;

  beforeEach(() => {
    jest.resetModules();
    reg = require('./EffectRegistry');
  });

  it('registers and retrieves an effect by id', () => {
    const def = makeDef('amp', 'Amplify', 'Amplitude');
    reg.registerEffect(def);
    expect(reg.getEffect('amp')).toBe(def);
  });

  it('returns undefined for an unknown id', () => {
    expect(reg.getEffect('nope')).toBeUndefined();
  });

  it('throws on duplicate id', () => {
    reg.registerEffect(makeDef('dup', 'One', 'Utility'));
    expect(() => reg.registerEffect(makeDef('dup', 'Two', 'Utility'))).toThrow(
      'Effect already registered: dup'
    );
  });

  it('getAllEffects sorts by category (alphabetical) then name', () => {
    reg.registerEffect(makeDef('r', 'Reverse', 'Utility'));
    reg.registerEffect(makeDef('n', 'Normalize', 'Amplitude'));
    reg.registerEffect(makeDef('a', 'Amplify', 'Amplitude'));
    reg.registerEffect(makeDef('d', 'Remove DC Offset', 'Restoration'));
    reg.registerEffect(makeDef('i', 'Invert', 'Utility'));

    const order = reg.getAllEffects().map((e) => `${e.category}/${e.name}`);
    expect(order).toEqual([
      'Amplitude/Amplify',
      'Amplitude/Normalize',
      'Restoration/Remove DC Offset',
      'Utility/Invert',
      'Utility/Reverse',
    ]);
  });
});
