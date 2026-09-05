import { useCallback, useState, type CSSProperties } from 'react';
import {
  ClipboardPaste,
  Copy,
  Crop,
  Merge,
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
import { useSessionStore } from '../../multitrack/sessionStore';
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
 * Copy/Delete/Trim/Silence, an empty clipboard greys Paste, and Undo/Redo
 * follow whichever history is active (`edit.undo`'s predicate already routes
 * to the SESSION's history in the multitrack view and the document's
 * elsewhere, which is exactly the rule wanted here).
 *
 * F1 / M1 / M7 / D6 — what the Multitrack view does to these nine:
 *  - Split is ROUTED by view, not blocked: a marker at the cursor in the
 *    editors, a clip split at the edit cursor in the Multitrack (M1). Its
 *    tooltip follows the route, since the same button does two different
 *    things.
 *  - Merge (D6) is the M7 rule pointing the OTHER way: it is the one button
 *    that exists only in the Multitrack view, so the tooltip naming the view
 *    that CAN do it is its `title` — the EDITOR one — and `multitrackTitle`
 *    describes the verb. No new field: `title` already serves that side.
 *  - Delete is routed too, and always was: it removes the selected clips there.
 *  - Copy, Paste, Trim and Silence stay greyed, because their COMMANDS are
 *    disabled there and not because this pill says so. Each edits a region of
 *    the active document, which that view does not show; Trim and Silence used
 *    to stay lit and would destroy the hidden document with the neighbouring
 *    Undo unable to reverse it (that Undo routes to the SESSION's history
 *    there). The prerequisites they lack are DIFFERENT — Copy and Paste want a
 *    clip clipboard the app does not have, Trim and Silence a time selection
 *    the view has no gesture for — so each says its own reason (M7) rather
 *    than sharing one paragraph that fits neither pair exactly.
 * The gate itself lives in the registry so the menu and the keyboard obey it
 * too; this component only chooses the tooltip that explains a greying the
 * predicate has already decided, because a missing button teaches nothing.
 */

export interface EditToolbarItem {
  label: string;
  commandId: string;
  Icon: LucideIcon;
  /** Starts a new group in the pill (renders a divider before it). */
  startsGroup?: boolean;
  /** Why this button is greyed in the Multitrack view — see the note above.
   * Drives the explanatory tooltip ONLY; enablement comes from the command. */
  multitrackReason?: string;
  /** The tooltip in the Multitrack view for a button whose command means
   * something ELSE there (Split), rather than nothing. */
  multitrackTitle?: string;
  title: string;
}

/** Split · Merge · Copy · Paste · Delete │ Trim · Silence │ Undo · Redo — the
 * mockup's three groups, in its order, on lucide line icons (the app's rule:
 * never emoji). Exported so the tests name the same nine the pill draws. */
export const EDIT_TOOLBAR_ITEMS: EditToolbarItem[] = [
  {
    label: 'Split',
    commandId: 'edit.split',
    Icon: Scissors,
    title: 'Split at Cursor (Ctrl+K) — a marker at the cursor, or at both edges of the selection',
    multitrackTitle:
      'Split at Cursor (Ctrl+K) — cuts every clip under the cursor on the selected clips’ tracks',
  },
  {
    // D6 — directly after Split, the verb it undoes. Blocked in the editors
    // rather than in Multitrack, so its `title` carries the M7 sentence.
    label: 'Merge',
    commandId: 'multitrack.mergeClips',
    Icon: Merge,
    title:
      'Merge Clips — not available in the Waveform and Spectral views: it joins the selected clips of a multitrack track into one. Switch to Multitrack to use it.',
    multitrackTitle:
      'Merge Clips — joins the selected clips on each track into one clip, silence in the gaps',
  },
  {
    label: 'Copy',
    commandId: 'edit.copy',
    Icon: Copy,
    multitrackReason: 'needs a clip clipboard',
    title: 'Copy (Ctrl+C)',
  },
  {
    label: 'Paste',
    commandId: 'edit.paste',
    Icon: ClipboardPaste,
    multitrackReason: 'needs a clip clipboard',
    title: 'Paste (Ctrl+V)',
  },
  {
    label: 'Delete',
    commandId: 'edit.delete',
    Icon: Trash2,
    title: 'Delete (Del)',
    // D3 — in the multitrack Delete has two jobs, and a button that does two
    // things has to name both: it removes the selected clips, or, when the
    // selection is a GAP (double-click empty lane space), closes it — every
    // clip after it on THAT track moves up by the gap's length.
    multitrackTitle:
      'Delete (Del) — removes the selected clips, or closes the selected gap: the clips after it on that track move up',
  },
  {
    label: 'Trim',
    commandId: 'edit.trim',
    Icon: Crop,
    startsGroup: true,
    multitrackReason: 'needs a time selection',
    title: 'Trim to Selection — keeps the selected region, drops the rest',
  },
  {
    label: 'Silence',
    commandId: 'edit.silence',
    Icon: VolumeX,
    multitrackReason: 'needs a time selection',
    title: 'Silence Selection — zeroes the selected region in place',
  },
  { label: 'Undo', commandId: 'edit.undo', Icon: Undo2, startsGroup: true, title: 'Undo (Ctrl+Z)' },
  { label: 'Redo', commandId: 'edit.redo', Icon: Redo2, title: 'Redo (Ctrl+Y)' },
];

/** M7 — one blocked tooltip, with this button's own reason inside it. The
 * words "Multitrack" and "Waveform or Spectral" stay in every one of them: the
 * refusal is only half the message, and naming the view that CAN do it is the
 * other half. */
const blockedTitle = (label: string, reason: string) =>
  `${label} — not available in the Multitrack view: ${reason}. Switch to Waveform or Spectral to edit the document.`;

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
  // Item 10: `edit.split`'s multitrack predicate reads the SESSION store — the
  // clips, the clip selection and the edit cursor — and every one of those
  // writers (`setMtCursor`, the selection setters) records nothing and touches
  // no appStore field. Without these three the Split button would grey and
  // un-grey one unrelated render LATE. Three narrow selectors rather than the
  // whole store on purpose: `mtPlayheadSample` ticks at pump rate during
  // playback and would repaint the pill with it.
  useSessionStore((s) => s.session);
  useSessionStore((s) => s.selectedClipIds);
  useSessionStore((s) => s.mtCursorSample);
  // D3: a double-click on empty lane space writes `selectedGap` and NOTHING
  // else, so without this the Delete/Ripple Delete predicates would light one
  // unrelated render late — the same argument as the three above.
  useSessionStore((s) => s.selectedGap);
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
      {EDIT_TOOLBAR_ITEMS.map((item) => {
        const { label, commandId, Icon, startsGroup, multitrackReason, multitrackTitle, title } =
          item;
        // F1: enablement is the COMMAND's, with nothing added here — the view
        // gate lives in the registry so this pill, the Edit menu and the
        // keyboard cannot disagree. The two multitrack fields only choose the
        // tooltip: why this button is dark (`multitrackReason`), or what it
        // does INSTEAD in that view (`multitrackTitle`).
        const disabled = !isCommandEnabled(commandId);
        const multitrackHint = isMultitrack
          ? multitrackReason !== undefined
            ? blockedTitle(label, multitrackReason)
            : (multitrackTitle ?? title)
          : title;
        return (
          <span key={commandId} className="flex items-center">
            {startsGroup && <span aria-hidden="true" style={divider} />}
            <button
              type="button"
              aria-label={label}
              title={multitrackHint}
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
