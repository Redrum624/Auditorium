import { getAllEffects } from '../../effects/EffectRegistry';
import type { EffectDefinition } from '../../effects/types';
import { openEffectDialog } from '../../services/dialogBus';
import { useAppStore } from '../../stores/appStore';

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
          <div className="px-2 py-1 text-xs font-semibold uppercase tracking-wide text-[#8b8b92]">
            {category}
          </div>
          <ul>
            {effects.map((e) => (
              <li key={e.id} data-testid="effects-item">
                <button
                  type="button"
                  disabled={!hasDoc}
                  onDoubleClick={() => hasDoc && openEffectDialog(e.id)}
                  title={hasDoc ? `Double-click to open ${e.name}` : 'Open a file first'}
                  className="w-full truncate px-3 py-1 text-left text-[#d4d4d8] enabled:hover:bg-[#2e2e34] disabled:cursor-default disabled:text-[#8b8b92] disabled:opacity-50"
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
