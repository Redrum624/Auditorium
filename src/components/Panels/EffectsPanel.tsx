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
 * What this card lists, and what it deliberately does not.
 *
 * The card is the registry's effects, grouped by category, followed by the
 * Effects MENU's own tool tail — today `spatial.position` alone, drawn as a
 * 'Mix' section (`effectsMenuTools`). A tool row is a door to a command that
 * already exists: the id is handed to `runCommand`, the label is read off the
 * registry, and the greying is `isCommandEnabled` — the command's own
 * predicate. No behaviour is added here, and none can be: a row that looks
 * live but is stale still cannot fire, because `runCommand` re-checks
 * enablement before running.
 *
 * A PIPELINE-menu command appears in the Pipeline module only. F11-6 listed
 * the ten Pipeline tools here as a second door, and U2 kept them when the
 * Pipeline module arrived; item 5 of the 2026-08-18 program removed them at
 * the user's ruling ("if it is in Pipeline, remove it from Effects"). The Mix
 * row stays because it is not a Pipeline tool: T8 moved `spatial.position` to
 * the Effects MENU, the strip draws no icon for Spatial, and this row is the
 * positioner's only door outside that menu.
 */

// Shared by the effect rows and the tool rows: `truncate` plus the fixed
// content width is what keeps a long label from widening the card.
const ROW_BUTTON_CLASS =
  'mx-1 w-[calc(100%-0.5rem)] truncate rounded-lg px-2 py-1 text-left text-[#d4d4d8] enabled:hover:bg-white/5 disabled:cursor-default disabled:text-[#8b8b92] disabled:opacity-50';

/**
 * T8: the Effects MENU's own tool tail — every command row of that menu that
 * is neither a registry effect (`effect.*`), a category label
 * (`effects.cat.*`), the empty-registry stub, nor the noise-print primer that
 * heads the list. Today that is `spatial.position` alone, closing the menu as
 * its own Mix group. MEMBERSHIP and ORDER are read from the menu at render
 * time, exactly as `getPipelineGroups()` reads the Pipeline section — a
 * command added to the tail appears on this card with no edit here. The 'Mix'
 * NAME is written at the call site, for `PIPELINE_GROUP_TITLES`' reason: the
 * menu marks the group with a bare separator, which carries no name.
 */
function effectsMenuTools(): { id: string; label: string }[] {
  const section = getMenuSections().find((s) => s.title === 'Effects');
  if (!section) return [];
  const rows: { id: string; label: string }[] = [];
  for (const item of section.items) {
    if (item === 'separator') continue;
    if (item.id === 'noise.capture' || item.id === 'effects.none') continue;
    if (item.id.startsWith('effect.') || item.id.startsWith('effects.cat.')) continue;
    // `label === id` is `fallbackCommand`'s placeholder for an unregistered
    // id — dropped, as `getPipelineGroups` drops it: such a row could never
    // run and would show a raw id as its name.
    if (item.label !== item.id) rows.push({ id: item.id, label: item.label });
  }
  return rows;
}

/**
 * Effects browser: every registered effect grouped by category, then the
 * Effects menu's own Mix row.
 *
 * Item 6 (2026-08-18): an effect row and a tool row are both ONE click. An
 * effect used to demand a double-click — the row named a parameter set the
 * user was about to fill in, so the first click selected and the second
 * committed to a modal. An effect now opens as a CARD in the module column
 * (between the module strip and this card, the same width as both), which is
 * not a commitment: nothing is dimmed, the stage stays live, and the card is
 * one ✕ from gone. The row is enabled only with a document active, mirroring
 * the menu's enablement; the tooltip says what a click does.
 */
export default function EffectsPanel() {
  // Subscribe to the whole store so every command predicate is recomputed on
  // any state change — MenuBar's and EditToolbar's own subscription, for the
  // same reason: `spatial.position`'s predicate is session-scoped, not a
  // function of the active document id alone.
  useAppStore((s) => s);
  const activeDocumentId = useAppStore((s) => s.activeDocumentId);
  const groups = groupByCategory(getVisibleEffects());
  const mixTools = effectsMenuTools();
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
                      onClick={() => hasDoc && openEffectDialog(e.id)}
                      title={hasDoc ? `Click to open ${e.name}` : 'Open a file first'}
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

      {/* T8: the Effects menu's own Mix group — see `effectsMenuTools`. Drawn
          below the effect list, where F11-8's Mix section always sat, with the
          same testids, same row, same registry-resolved label and
          command-owned greying. The Pipeline groups that used to sit between
          the list and this section live in the Pipeline module only (item 5). */}
      {mixTools.length > 0 && (
        <div data-testid="effects-tool-section" data-section="Mix">
          <SectionLabel className="px-2 pb-1 pt-2">Mix</SectionLabel>
          <ul>{mixTools.map(({ id, label }) => toolRow(id, label, hasDoc))}</ul>
        </div>
      )}
    </div>
  );
}

/** One tool row: the id goes to `runCommand`, the label is the registry's,
 * the greying is `isCommandEnabled` — the command's own predicate. The same
 * row shape the Pipeline card draws, so a command row reads alike on both. */
function toolRow(id: string, label: string, hasDoc: boolean) {
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
}
