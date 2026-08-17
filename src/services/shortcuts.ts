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
  // K1 — Ripple Delete. `Shift+Delete` was free in this table (checked against
  // every row above and below), and it is the combo the verb carries in the
  // NLEs this feature was asked to match. Its command is multitrack-only, so
  // in the editor views the key reaches a disabled command and does nothing —
  // `runCommand` re-checks `enabled` before running, which is what keeps a
  // global table from needing a per-view table beside it.
  { combo: 'shift+delete', commandId: 'edit.rippleDelete' },
  { combo: 'ctrl+a', commandId: 'edit.selectAll' },
  // K1 — clip-edge navigation. `e.key` for the arrows is 'ArrowLeft'/
  // 'ArrowRight', so the normalized combos carry the 'arrow' prefix; the menu
  // rows advertise them as the Ctrl+Left / Ctrl+Right a user would write.
  //
  // Nothing else in this app binds an arrow, and the evidence is stronger than
  // the sentence that used to stand here: a repo-wide search for
  // `ArrowLeft|ArrowRight` outside tests finds these two rows and a
  // `lucide-react` ICON import in `ConvertDialog` (`ArrowLeftRight`, drawn on a
  // button) — there is no arrow-key handler anywhere in `src/`. The earlier
  // wording cited ConvertDialog's "form controls" as the one arrow reader,
  // which described a handler that does not exist; a phantom to defer to is a
  // worse note to leave behind than the real absence, because the next editor
  // goes looking for it.
  { combo: 'ctrl+arrowleft', commandId: 'multitrack.prevClipEdge' },
  { combo: 'ctrl+arrowright', commandId: 'multitrack.nextClipEdge' },
  { combo: 'home', commandId: 'transport.goToStart' },
  { combo: 'end', commandId: 'transport.goToEnd' },
  { combo: 'ctrl+o', commandId: 'file.open' },
  { combo: 'ctrl+s', commandId: 'file.save' },
  { combo: 'ctrl+n', commandId: 'file.new' },
  // T4 — the third of the same drift, and the one the Ctrl+W fix left behind.
  // `file.saveAs` has advertised `Ctrl+Shift+S` on its File menu row since the
  // row existed, with no combo here: the label named a key that did nothing.
  // It routes to the same `saveDocument(id, true)` the row runs, so the
  // accelerator does exactly what clicking the row does — including the save
  // dialog, so it can never overwrite anything without being asked.
  //
  // `ctrl+shift+s` was free: checked against every row above and below, and
  // `comboFromEvent` emits modifiers in a fixed `ctrl+shift+alt` order, so
  // there is one spelling of it and this is it. The sweep in shortcuts.test.ts
  // now checks the whole class rather than this one key.
  { combo: 'ctrl+shift+s', commandId: 'file.saveAs' },
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

    // A MATCHED combo is claimed here, before `runCommand` consults the
    // command's own `enabled` predicate — so a row whose command is disabled in
    // the current view still swallows the platform default. K1's
    // `ctrl+arrowleft`/`ctrl+arrowright` and `shift+delete` are multitrack-only
    // commands, so that is now observable in the waveform and spectral views.
    //
    // Kept deliberately rather than gated on `isCommandEnabled`, and recorded
    // here so it is not rediscovered as a defect: enablement-gating would hand
    // Chromium's own defaults back exactly where this table means to own the
    // key — Ctrl+S "save page as", Ctrl+O "open file", space-scroll — in every
    // view where the app happens to have nothing to do with it. The cost is
    // bounded by `isEditableTarget` above, which has already returned for
    // INPUT/TEXTAREA/SELECT/contentEditable, so word-jump and Delete still
    // behave normally in the only places a user types.
    e.preventDefault();
    void runCommand(commandId);
  };

  target.addEventListener('keydown', handleKeydown);
  return () => target.removeEventListener('keydown', handleKeydown);
}
