import { hasOpenDialog } from './dialogBus';
import { runCommand } from './menuActions';

export interface Shortcut {
  combo: string; // normalized 'ctrl+shift+alt+key', e.g. 'ctrl+z', 'space', 'ctrl+shift+z'
  commandId: string;
}

/** Global combo -> command map. Order is not significant for lookup (a Map is
 * built from it), but is kept in a logical grouping for readability. */
export const SHORTCUT_TABLE: Shortcut[] = [
  { combo: 'space', commandId: 'transport.playPause' },
  { combo: 'ctrl+z', commandId: 'edit.undo' },
  { combo: 'ctrl+shift+z', commandId: 'edit.redo' },
  { combo: 'ctrl+y', commandId: 'edit.redo' },
  { combo: 'ctrl+x', commandId: 'edit.cut' },
  { combo: 'ctrl+c', commandId: 'edit.copy' },
  { combo: 'ctrl+v', commandId: 'edit.paste' },
  { combo: 'delete', commandId: 'edit.delete' },
  { combo: 'ctrl+a', commandId: 'edit.selectAll' },
  { combo: 'home', commandId: 'transport.goToStart' },
  { combo: 'end', commandId: 'transport.goToEnd' },
  { combo: 'ctrl+o', commandId: 'file.open' },
  { combo: 'ctrl+s', commandId: 'file.save' },
  { combo: 'ctrl+n', commandId: 'file.new' },
  // The File menu has advertised `Ctrl+W` on its Close row since Task 11, but
  // this table never carried the combo, so the label named a key that did
  // nothing. It routes to `file.close`, i.e. `closeDocumentFlow` — the
  // prompt-first path — so the accelerator can never discard unsaved work
  // silently.
  { combo: 'ctrl+w', commandId: 'file.close' },
  { combo: 'm', commandId: 'marker.add' },
  { combo: 'ctrl+e', commandId: 'file.export' },
  { combo: 'escape', commandId: 'edit.deselect' },
];

const STANDALONE_MODIFIER_KEYS = new Set(['control', 'shift', 'alt', 'meta']);

/** Normalizes a keydown event into a combo string: modifiers in a fixed
 * 'ctrl+shift+alt' order (Meta is not part of the documented table and is
 * intentionally not encoded), followed by the lowercased key. The space bar
 * maps to the literal 'space'. Standalone modifier keydowns (pressing just
 * Ctrl/Shift/Alt/Meta) normalize to '' since they never form a usable combo. */
export function comboFromEvent(e: KeyboardEvent): string {
  const key = e.key.toLowerCase();
  if (STANDALONE_MODIFIER_KEYS.has(key)) return '';

  const parts: string[] = [];
  if (e.ctrlKey) parts.push('ctrl');
  if (e.shiftKey) parts.push('shift');
  if (e.altKey) parts.push('alt');
  parts.push(key === ' ' ? 'space' : key);
  return parts.join('+');
}

/** True when the event target is a form control or contenteditable element
 * that should receive normal typed input instead of triggering a shortcut. */
function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  return target.isContentEditable;
}

const COMBO_TO_COMMAND: Map<string, string> = new Map(
  SHORTCUT_TABLE.map((s) => [s.combo, s.commandId])
);

/** Installs a single keydown listener on `target` that maps SHORTCUT_TABLE
 * combos to `runCommand`. Skips input/textarea/select/contentEditable focus
 * targets and IME composition so typing is never hijacked, and bails entirely
 * while any dialog is open (F10) — with a dialog open, focus commonly sits on
 * body or a plain BUTTON, so without this gate ctrl+n/ctrl+o/ctrl+e/ctrl+s/m/
 * space/delete would still fire behind it; several dialogs resolve their
 * target document from the live activeDocumentId at confirm time, so e.g.
 * Ctrl+O while Export is open would make Export write the wrong document.
 * Returns an uninstaller that removes the listener. */
export function installShortcuts(target: Window): () => void {
  const handleKeydown = (e: KeyboardEvent): void => {
    if (e.isComposing) return;
    if (hasOpenDialog()) return;
    if (isEditableTarget(e.target)) return;

    const combo = comboFromEvent(e);
    if (!combo) return;

    const commandId = COMBO_TO_COMMAND.get(combo);
    if (!commandId) return;

    e.preventDefault();
    void runCommand(commandId);
  };

  target.addEventListener('keydown', handleKeydown);
  return () => target.removeEventListener('keydown', handleKeydown);
}
