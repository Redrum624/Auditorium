import { getVisibleEffects } from '../../effects/EffectRegistry';
import type { EffectDefinition } from '../../effects/types';
import { openEffectDialog } from '../../services/dialogBus';
import { getMenuSections, isCommandEnabled, runCommand } from '../../services/menuActions';
// U2: the Pipeline menu's rows and groups, derived once and shared with the
// Pipeline module's card.
import { getPipelineGroups } from '../../services/pipelineTools';
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
 * was the one surface that never learned about them. Each row is a SECOND DOOR
 * to a command that already exists: the id is handed to `runCommand`, the label
 * is read off the registry, and the greying is `isCommandEnabled` — the
 * command's own predicate. No behaviour is added here, and none can be: a row
 * that looks live but is stale still cannot fire, because `runCommand`
 * re-checks enablement before running.
 *
 * The sections are the questions the tools answer, in the order a cover is
 * actually made. F11-8 filled the fourth, 'Mix', once `spatial.position`
 * existed.
 *
 * U2: the roster and its groups MOVED to `services/pipelineTools.ts`,
 * where they are derived from the Pipeline menu's own separator-delimited
 * section instead of being restated. F11-6 wrote the id list here because this
 * was the only card that showed the tools; U2 adds a second (the Pipeline
 * module), and two hand-maintained copies of the same ids would have
 * disagreed with the menu — and with each other — the first time a tool moved
 * group. What changed is that they can no longer drift apart.
 *
 * T8: the Mix section stopped being one of those Pipeline groups. The user
 * moved `spatial.position` to the Effects MENU ("move the Spacial tool to the
 * effects module"), so `getPipelineGroups()` no longer carries it — this card
 * now draws the Effects menu's own tool tail (`effectsMenuTools`) as the Mix
 * section, after the Pipeline groups, in the same visual language. The card
 * looks exactly as it did; what moved is which menu the row is read from.
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
  // same reason: the advanced tools are gated on more than the active doc id
  // (Auto-Remix, Transcribe, Separate and Align Lyrics also need audio in it).
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

      {getPipelineGroups().map(({ title, commands }, i) => {
        if (commands.length === 0) return null;
        return (
          <div
            key={title ?? `group-${i}`}
            data-testid="effects-tool-section"
            data-section={title ?? ''}
          >
            {title !== null && <SectionLabel className="px-2 pb-1 pt-2">{title}</SectionLabel>}
            <ul>
              {commands.map(({ id, label }) => toolRow(id, label, hasDoc))}
            </ul>
          </div>
        );
      })}

      {/* T8: the Effects menu's own Mix group — see `effectsMenuTools`. Drawn
          after the Pipeline groups, where F11-8's Mix section always sat, and
          in the identical visual language: same testids, same row, same
          registry-resolved label and command-owned greying. */}
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
 * the greying is `isCommandEnabled` — the command's own predicate. Shared by
 * the Pipeline groups and the Mix section so the two cannot diverge. */
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
