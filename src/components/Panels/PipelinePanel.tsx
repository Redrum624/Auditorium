import { getPipelineGroups } from '../../services/pipelineTools';
import { isCommandEnabled, runCommand } from '../../services/menuActions';
import { useAppStore } from '../../stores/appStore';
import { SectionLabel } from '../UI/glass';

/**
 * U2 — the Pipeline module's card.
 *
 * The user asked to "add a module 'Pipeline' to choose pipelines from". This is
 * that chooser, and it is deliberately the THINNEST possible surface over the
 * Pipeline menu: `getPipelineGroups()` reads the menu's own rows, the label is
 * the registry's, the greying is `isCommandEnabled` — the command's own
 * predicate — and the click is `runCommand`. Nothing here can drift from the
 * menu, because nothing here restates it.
 *
 * Why a module and not the Effects card's tool list (F11-6), which used to
 * show the same rows: the Effects card is an EFFECT browser with the tools
 * appended below a long scrolling list, so reaching Cover Chain there meant
 * scrolling past every registered effect. A module is a place you go — one
 * click on the strip and the tools are the whole card. Item 5 of the
 * 2026-08-18 program then made this card the ONLY one: a Pipeline tool no
 * longer appears in the Effects card at all ("if it is in Pipeline, remove it
 * from Effects"), and this card renders `getPipelineGroups()` alone.
 *
 * The rows are a SINGLE click, matching the menu and the Effects card's rows
 * — since item 6 an effect row is one click too, opening its card in the
 * module column.
 */
const ROW_BUTTON_CLASS =
  'mx-1 w-[calc(100%-0.5rem)] truncate rounded-lg px-2 py-1 text-left text-[#d4d4d8] enabled:hover:bg-white/5 disabled:cursor-default disabled:text-[#8b8b92] disabled:opacity-50';

export default function PipelinePanel() {
  // Subscribe to the whole store so every command predicate is recomputed on
  // any state change — MenuBar's, EditToolbar's and EffectsPanel's own
  // subscription, for the same reason: these tools are gated on more than the
  // active document id (most also need audio in it).
  useAppStore((s) => s);
  const activeDocumentId = useAppStore((s) => s.activeDocumentId);
  const hasDoc = activeDocumentId !== null;
  const groups = getPipelineGroups();

  return (
    <div data-testid="pipeline-panel" className="flex flex-col py-1 text-sm">
      {groups.map(({ title, commands }, i) => {
        if (commands.length === 0) return null;
        return (
          <div
            key={title ?? `group-${i}`}
            data-testid="pipeline-section"
            data-section={title ?? ''}
          >
            {/* A group the menu grew past `PIPELINE_GROUP_TITLES` draws its
                rows with no heading rather than an invented one. */}
            {title !== null && <SectionLabel className="px-2 pb-1 pt-2">{title}</SectionLabel>}
            <ul>
              {commands.map(({ id, label }) => {
                const enabled = isCommandEnabled(id);
                return (
                  <li key={id} data-testid="pipeline-item" data-command-id={id}>
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
