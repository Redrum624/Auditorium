import { getVisibleEffects } from '../../effects/EffectRegistry';
import type { EffectDefinition } from '../../effects/types';
import { openEffectDialog } from '../../services/dialogBus';
import { getMenuSections, isCommandEnabled, runCommand } from '../../services/menuActions';
import { useAppStore } from '../../stores/appStore';
import { SectionLabel } from '../UI/glass';

/** Groups effects by category, preserving the getVisibleEffects() sort order. */
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
 * F11-6: the advanced tools, below the effect list.
 *
 * Ten tools shipped menu-only across ten releases while this card kept listing
 * the plain effect registry alone — so the surface the user reaches for first
 * was the one surface that never learned about them. Each entry below is a
 * SECOND DOOR to a command that already exists: the id is handed to
 * `runCommand`, the label is read off the registry, and the greying is
 * `isCommandEnabled` — the command's own predicate. No behaviour is added
 * here, and none can be: a row that looks live but is stale still cannot fire,
 * because `runCommand` re-checks enablement before running.
 *
 * The sections are the three questions the tools answer, in the order a cover
 * is actually made. A fourth 'Mix' section belongs after 'Analysis' once a
 * spatial command exists to put in it — there is no such command today, and a
 * row pointing at an unregistered id would render as a permanently grey
 * mystery, so the space is left rather than filled.
 */
const TOOL_SECTIONS: { title: string; commandIds: string[] }[] = [
  {
    title: 'Tempo & Timing',
    commandIds: ['tempo.detect', 'tempo.match', 'timing.align', 'edit.remix'],
  },
  {
    title: 'Voice',
    commandIds: ['edit.voiceChanger', 'effects.vocalChain', 'effects.coverChain', 'lyrics.align'],
  },
  { title: 'Analysis', commandIds: ['edit.transcribe', 'edit.separateStems'] },
];

/**
 * Every registered command's label, keyed by id, read out of the menu the user
 * already sees. `menuActions` exports no single-command getter, and this panel
 * may not grow its own copy of ten strings: a hardcoded 'Match Tempo…' here
 * would silently disagree with the menu the first time one is reworded, and
 * the ellipsis convention (a label ending in '…' opens a dialog) would become
 * two facts instead of one. `getMenuSections()` resolves ids against the live
 * registry on every call, so this is always current; it is rebuilt per render
 * for the same reason MenuBar rebuilds it per store change, and costs one pass
 * over the layout plus the effect list.
 *
 * An id that is in the layout but NOT registered comes back from
 * `fallbackCommand` labelled with the id itself — that is the one case where
 * this map reports a label it should not draw, and `toolRows` drops it.
 */
function registryLabels(): Map<string, string> {
  const labels = new Map<string, string>();
  for (const section of getMenuSections()) {
    for (const item of section.items) {
      if (item !== 'separator') labels.set(item.id, item.label);
    }
  }
  return labels;
}

/** The rows to draw for a section: registered commands only, in listed order. */
function toolRows(commandIds: string[], labels: Map<string, string>): { id: string; label: string }[] {
  const rows: { id: string; label: string }[] = [];
  for (const id of commandIds) {
    const label = labels.get(id);
    // `label === id` is `fallbackCommand`'s placeholder for an unregistered id:
    // a row for one could never run and would show a raw id as its name.
    if (label !== undefined && label !== id) rows.push({ id, label });
  }
  return rows;
}

// Shared by the effect rows and the tool rows: `truncate` plus the fixed
// content width is what keeps a long label from widening the card.
const ROW_BUTTON_CLASS =
  'mx-1 w-[calc(100%-0.5rem)] truncate rounded-lg px-2 py-1 text-left text-[#d4d4d8] enabled:hover:bg-white/5 disabled:cursor-default disabled:text-[#8b8b92] disabled:opacity-50';

/**
 * Left-sidebar effects browser: every registered effect grouped by category,
 * then the advanced tools grouped by what they do.
 *
 * Double-clicking an effect opens its parameter dialog (only when a document is
 * active, mirroring the menu's enablement). A TOOL row is a SINGLE click, and
 * that difference is deliberate: an effect row names a parameter set the user
 * is about to fill in, so a click selects it and the second click commits to
 * the dialog; a tool row names a verb the menu also fires on one click, and
 * making the panel demand two would make the second door slower than the
 * first. Each row's tooltip says which it is.
 */
export default function EffectsPanel() {
  // Subscribe to the whole store so every command predicate is recomputed on
  // any state change — MenuBar's and EditToolbar's own subscription, for the
  // same reason: the ten tools are gated on more than the active document id
  // (Auto-Remix, Transcribe, Separate and Align Lyrics also need audio in it).
  useAppStore((s) => s);
  const activeDocumentId = useAppStore((s) => s.activeDocumentId);
  const groups = groupByCategory(getVisibleEffects());
  const labels = registryLabels();
  const hasDoc = activeDocumentId !== null;

  return (
    <div data-testid="effects-panel" className="flex flex-col py-1 text-sm">
      {groups.length === 0 ? (
        <div className="p-2 text-[#8b8b92]">No effects loaded.</div>
      ) : (
        <div data-testid="effects-list" className="flex flex-col">
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
                      className={ROW_BUTTON_CLASS}
                    >
                      {e.name}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}

      {TOOL_SECTIONS.map(({ title, commandIds }) => {
        const rows = toolRows(commandIds, labels);
        if (rows.length === 0) return null;
        return (
          <div key={title} data-testid="effects-tool-section" data-section={title}>
            <SectionLabel className="px-2 pb-1 pt-2">{title}</SectionLabel>
            <ul>
              {rows.map(({ id, label }) => {
                const enabled = isCommandEnabled(id);
                return (
                  <li key={id} data-testid="effects-tool-item" data-command-id={id}>
                    <button
                      type="button"
                      disabled={!enabled}
                      onClick={() => void runCommand(id)}
                      title={
                        enabled
                          ? `Click to run ${label}`
                          : hasDoc
                            ? `${label} — not available for this file right now`
                            : 'Open a file first'
                      }
                      className={ROW_BUTTON_CLASS}
                    >
                      {label}
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        );
      })}
    </div>
  );
}
