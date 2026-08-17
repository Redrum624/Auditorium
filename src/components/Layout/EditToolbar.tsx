import { useCallback, useState, type CSSProperties } from 'react';
import {
  ClipboardPaste,
  Copy,
  Crop,
  Redo2,
  Scissors,
  Trash2,
  Undo2,
  VolumeX,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { isCommandEnabled, runCommand } from '../../services/menuActions';
import { useHistoryVersion } from '../../services/undoHistory';
import { useAppStore } from '../../stores/appStore';
import { ChromePill } from '../UI/glass';

/**
 * U1 (layout E2, element 5): the edit toolbar — icons only, its own glass
 * pill, floating above the bottom bar on the waveform's axis (App owns the
 * band and the 16px of clear air between the two).
 *
 * It adds NO edit logic. Every button is an id handed to `runCommand`, and
 * every enabled state is that command's OWN predicate read through
 * `isCommandEnabled` — the same function object the Edit menu evaluates. A
 * button that looks live but is stale therefore still cannot fire: runCommand
 * re-checks enablement before running, so the registry is the single gate.
 *
 * Visibility (the user's rule, final): present in Waveform, Spectral AND
 * Multitrack whenever at least one sound file is loaded; hidden only in the
 * empty app. Per-button greying does the rest — no selection greys
 * Cut/Copy/Delete/Trim/Silence, an empty clipboard greys Paste, and Undo/Redo
 * follow whichever history is active (`edit.undo`'s predicate already routes
 * to the SESSION's history in the multitrack view and the document's
 * elsewhere, which is exactly the rule wanted here).
 *
 * F1: the five REGION verbs — Cut, Copy, Paste, Trim, Silence — are greyed in
 * the Multitrack view because their COMMANDS are disabled there, not because
 * this pill says so. Each edits a region of the active document, which that
 * view does not show; Trim and Silence used to stay lit and would destroy the
 * hidden document with the neighbouring Undo unable to reverse it (that Undo
 * routes to the SESSION's history there). The gate lives in the registry so
 * the menu and the keyboard obey it too — this component only chooses the
 * tooltip that explains the greying, because a missing button teaches nothing.
 * Delete is excluded: it already routes to clip removal in that view.
 */

export interface EditToolbarItem {
  label: string;
  commandId: string;
  Icon: LucideIcon;
  /** Starts a new group in the pill (renders a divider before it). */
  startsGroup?: boolean;
  /** Acts on a REGION of the active document — see the Multitrack note above.
   * Drives the explanatory tooltip ONLY; enablement comes from the command. */
  regionVerb?: boolean;
  title: string;
}

/** Cut · Copy · Paste · Delete │ Trim · Silence │ Undo · Redo — the mockup's
 * three groups, in its order, on lucide line icons (the app's rule: never
 * emoji). Exported so the tests name the same eight the pill draws. */
export const EDIT_TOOLBAR_ITEMS: EditToolbarItem[] = [
  { label: 'Cut', commandId: 'edit.cut', Icon: Scissors, regionVerb: true, title: 'Cut (Ctrl+X)' },
  { label: 'Copy', commandId: 'edit.copy', Icon: Copy, regionVerb: true, title: 'Copy (Ctrl+C)' },
  {
    label: 'Paste',
    commandId: 'edit.paste',
    Icon: ClipboardPaste,
    regionVerb: true,
    title: 'Paste (Ctrl+V)',
  },
  { label: 'Delete', commandId: 'edit.delete', Icon: Trash2, title: 'Delete (Del)' },
  {
    label: 'Trim',
    commandId: 'edit.trim',
    Icon: Crop,
    startsGroup: true,
    regionVerb: true,
    title: 'Trim to Selection — keeps the selected region, drops the rest',
  },
  {
    label: 'Silence',
    commandId: 'edit.silence',
    Icon: VolumeX,
    regionVerb: true,
    title: 'Silence Selection — zeroes the selected region in place',
  },
  { label: 'Undo', commandId: 'edit.undo', Icon: Undo2, startsGroup: true, title: 'Undo (Ctrl+Z)' },
  { label: 'Redo', commandId: 'edit.redo', Icon: Redo2, title: 'Redo (Ctrl+Y)' },
];

const MULTITRACK_REGION_TITLE =
  'Not available in the Multitrack view — it edits a region of the active document, which this view does not show. Switch to Waveform or Spectral to edit the document.';

// Toolbar.tsx `pillIconBtn`, verbatim: the interactive hover/press/disabled
// states come from .glass-pill-btn in index.css, which inline styles cannot
// express.
const editIconBtn: CSSProperties = {
  width: 30,
  height: 30,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  padding: 0,
  borderRadius: 9,
  border: '1px solid transparent',
  background: 'transparent',
  color: 'var(--glass-text-chrome-primary)',
  cursor: 'pointer',
};

const divider: CSSProperties = {
  width: 1,
  height: 16,
  margin: '0 4px',
  background: 'var(--glass-border)',
  flexShrink: 0,
};

export default function EditToolbar() {
  // Subscribe to the whole store so every predicate is recomputed on any state
  // change — the MenuBar's own subscription, for the same reason.
  useAppStore((s) => s);
  // R3: session undo entries write the SESSION store, not the app store, so
  // Undo/Redo enablement in the multitrack view also needs the history's
  // version counter (MenuBar carries the identical pair).
  useHistoryVersion();
  const documentCount = useAppStore((s) => s.documents.length);
  const isMultitrack = useAppStore((s) => s.view) === 'multitrack';

  // The in-app clipboard is a module slot with no subscribers, so a Copy from
  // THIS pill changes no store and would leave Paste grey until the next
  // unrelated state change. One local tick after the command settles closes
  // that gap for the pill's own path (the keyboard path shares the Edit
  // menu's existing latency, which this task does not change).
  const [, setTick] = useState(0);
  const run = useCallback(async (id: string) => {
    await runCommand(id);
    setTick((t) => t + 1);
  }, []);

  // "Hidden only in the empty app" — one loaded file is enough, in any view.
  if (documentCount === 0) return null;

  return (
    <ChromePill
      data-testid="edit-pill"
      className="pointer-events-auto flex items-center"
      style={{ borderRadius: 14, padding: '6px 8px', gap: 3 }}
    >
      {EDIT_TOOLBAR_ITEMS.map(({ label, commandId, Icon, startsGroup, regionVerb, title }) => {
        // F1: enablement is the COMMAND's, with nothing added here — the view
        // gate lives in the registry so this pill, the Edit menu and the
        // keyboard cannot disagree. `blockedByView` only chooses the tooltip
        // that explains a greying the predicate has already decided.
        const disabled = !isCommandEnabled(commandId);
        const blockedByView = isMultitrack && regionVerb === true;
        return (
          <span key={commandId} className="flex items-center">
            {startsGroup && <span aria-hidden="true" style={divider} />}
            <button
              type="button"
              aria-label={label}
              title={blockedByView ? `${label} — ${MULTITRACK_REGION_TITLE}` : title}
              disabled={disabled}
              onClick={() => void run(commandId)}
              className="glass-pill-btn"
              style={editIconBtn}
            >
              <Icon size={15} />
            </button>
          </span>
        );
      })}
    </ChromePill>
  );
}
