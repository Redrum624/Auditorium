import { getAllEffects } from '../../effects/EffectRegistry';
import type { EffectDefinition } from '../../effects/types';
import { openEffectDialog } from '../../services/dialogBus';
import { useAppStore } from '../../stores/appStore';
import { SectionLabel } from '../UI/glass';

/** Groups effects by category, preserving the getAllEffects() sort order. */
function groupByCategory(effects: EffectDefinition[]): [string, EffectDefinition[]][] {
  const groups: [string, EffectDefinition[]][] = [];
  for (const e of effects) {
    const last = groups[groups.length - 1];
    if (last && last[0] === e.category) last[1].push(e);
    else groups.push([e.category, [e]]);
  }
  return groups;
}

/**
 * Left-sidebar effects browser: every registered effect grouped by category.
 * Double-clicking an effect opens its parameter dialog (only when a document is
 * active, mirroring the menu's enablement).
 */
export default function EffectsPanel() {
  const activeDocumentId = useAppStore((s) => s.activeDocumentId);
  const groups = groupByCategory(getAllEffects());

  if (groups.length === 0) {
    return <div className="p-2 text-sm text-[#8b8b92]">No effects loaded.</div>;
  }

  const hasDoc = activeDocumentId !== null;

  return (
    <div data-testid="effects-list" className="flex flex-col py-1 text-sm">
      {groups.map(([category, effects]) => (
        <div key={category}>
          {/* G4 glass restyle (styling only): the category header is the
              shared SectionLabel primitive; rows get white-alpha hover. */}
          <SectionLabel className="px-2 pb-1 pt-2">{category}</SectionLabel>
          <ul>
            {effects.map((e) => (
              <li key={e.id} data-testid="effects-item">
                <button
                  type="button"
                  disabled={!hasDoc}
                  onDoubleClick={() => hasDoc && openEffectDialog(e.id)}
                  title={hasDoc ? `Double-click to open ${e.name}` : 'Open a file first'}
                  className="mx-1 w-[calc(100%-0.5rem)] truncate rounded-lg px-2 py-1 text-left text-[#d4d4d8] enabled:hover:bg-white/5 disabled:cursor-default disabled:text-[#8b8b92] disabled:opacity-50"
                >
                  {e.name}
                </button>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}
