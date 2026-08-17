import type { CSSProperties } from 'react';
import {
  Captions,
  Flag,
  Folder,
  History as HistoryIcon,
  Info,
  Orbit,
  Shuffle,
  Sparkles,
  Workflow,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { ChromePill } from '../UI/glass';

/**
 * U1 (layout E2): the G4 right-edge icon RAIL, rotated horizontal.
 *
 * The rail was a 58px-wide vertical column pinned to the window's right edge,
 * standing beside a 348px module column — 406px of chrome for eight icons and
 * one card. E2 folds the icons into a STRIP that sits on top of the module
 * column at the card's own width, so the two surfaces cost one width instead of
 * two and the waveform takes the whole difference. Nothing about what the
 * entries DO changed: same ids, same order, same lucide glyphs, the same
 * `sidebar-tabs` testid and the same accessible names the packaged smoke and
 * the G4 tests drive it by (grep `sidebar-tabs` in scripts/e2e-smoke.cjs).
 *
 * One behaviour is new, and E2 requires it: clicking the ACTIVE entry closes
 * the panel card. "With no card open the stage runs nearly the full window
 * width" is only reachable if the card can be closed at all, and the strip's
 * own entry is the only affordance that can close the thing it opened without
 * inventing a second control. `aria-pressed` already says which state a click
 * would leave, and the title spells the toggle out.
 */
/**
 * F11: the split. `PanelId` names every panel the module CARD can render;
 * the strip draws icons for a subset of them (`stripTabs`).
 *
 * They were one list until the user ruled: "Spatial and Transcript are single
 * tools, they should not be a module. Remix should only appear when a remix is
 * created." A strip entry is a claim that something is a MODULE — a place you
 * go and work — and a tool that answers one question is not that, however good
 * its panel is. Nothing about the panels changed; only who draws a door to
 * them. `App.tsx` renders the card from `MODULE_PANELS`, so a panel with no
 * icon still gets the card's header, its icon and its name.
 */
export type PanelId =
  | 'files'
  | 'effects'
  | 'pipeline'
  | 'markers'
  | 'history'
  | 'properties'
  | 'remix'
  | 'spatial'
  | 'transcript';

/**
 * U2: where an entry sits in the strip, as a PROPERTY of the entry rather than
 * as its index in an array.
 *
 * The user gave two rules — "make 'Files' default at opening" and "'History'
 * always last" — and a hardcoded sequence can only satisfy them for today's
 * roster. The next module appended to `MODULE_PANELS` would land after History
 * and break the second rule silently, exactly as Pipeline would have. Slots
 * make both rules structural: `stripTabs` orders by slot rank, so a new entry
 * declares `'body'` and lands between the two ends no matter where in the array
 * it is written. `ModuleStrip.test` pins that there is exactly one `lead` and
 * exactly one `trail`, so neither rule can be doubled or quietly moved either.
 *
 * - `lead` — first, always. Also the card the app opens with (`DEFAULT_PANEL`).
 * - `body` — the middle, in declaration order.
 * - `contextual` — drawn only while its condition holds (Remix: a remix
 *   document exists). After the body, before the trail — F11-8 put it after
 *   the permanents and U2 does not move it; History overtakes it.
 * - `trail` — last, always.
 * - `none` — no strip icon at all. The card still renders the panel; a command
 *   is its only door (F11-8's ruling for Spatial and Transcript).
 */
export type StripSlot = 'lead' | 'body' | 'contextual' | 'trail' | 'none';

/** U2: slot rank — the strip's order, stated once. `e2e-navigate.cjs` reads
 * this array out of this file to derive the roster it asserts against, so the
 * packaged run cannot drift from it either. */
export const STRIP_SLOT_ORDER: readonly StripSlot[] = ['lead', 'body', 'contextual', 'trail'];

export interface PanelEntry {
  id: PanelId;
  label: string;
  Icon: LucideIcon;
  /** U2: see `StripSlot`. */
  slot: StripSlot;
}

// F11: the CARD's registry — every panel it can render, icons or not.
// U2: written in strip order for readability, but `stripTabs` orders by SLOT —
// the array's order only decides the `body` run.
export const MODULE_PANELS: PanelEntry[] = [
  { id: 'files', label: 'Files', Icon: Folder, slot: 'lead' },
  { id: 'effects', label: 'Effects', Icon: Sparkles, slot: 'body' },
  // U2: the Pipeline module — the card lists the Pipeline MENU's tools from the
  // same registry (see PipelinePanel), so it sits directly after Effects here
  // for the same reason it sits after Effects in the menu bar: the two are the
  // same shelf at two depths, plain effects then the multi-stage passes.
  { id: 'pipeline', label: 'Pipeline', Icon: Workflow, slot: 'body' },
  { id: 'markers', label: 'Markers', Icon: Flag, slot: 'body' },
  { id: 'properties', label: 'Properties', Icon: Info, slot: 'body' },
  // F11: contextual — an icon only while a remix document exists (see
  // `stripTabs`). Also reached the moment one is created, through
  // `focusRemixPanel()`.
  { id: 'remix', label: 'Remix', Icon: Shuffle, slot: 'contextual' },
  // U2: History moved from the middle of the permanents to the trail slot, on
  // the user's rule. Nothing about the panel changed.
  { id: 'history', label: 'History', Icon: HistoryIcon, slot: 'trail' },
  // F5 — the spatial positioner (stereo projection; lucide line icon, never
  // emoji). F11: no strip icon any more — it is reached by the
  // `spatial.position` command (Effects > Mix since T8, and the Effects
  // card's Mix section). The panel is unchanged, and it is still a CARD rather than a
  // track-header popover for F5's own reason: the positioner is
  // playhead-scoped, not row-scoped, and the 348px card gives the stage room
  // the 96px track row never could.
  { id: 'spatial', label: 'Spatial', Icon: Orbit, slot: 'none' },
  // F4b — the transcript (lucide line icon, never emoji). F11: no strip icon
  // any more — the Transcribe tool shows it (`edit.transcribe` reveals an
  // existing transcript instead of re-running the model). Still a card rather
  // than a dialog for F4b's own reason: a transcript is read ALONGSIDE the
  // audio, one row scrubbed at a time over minutes, and a modal would have to
  // be dismissed to do the one thing it is for.
  { id: 'transcript', label: 'Transcript', Icon: Captions, slot: 'none' },
];

/** U2: the entries carrying `slot`, ordered by it — the strip's roster with
 * every contextual entry present. Stable within a rank, so the `body` run keeps
 * its declaration order. */
function bySlot(slots: readonly StripSlot[]): PanelEntry[] {
  return slots.flatMap((slot) => MODULE_PANELS.filter((p) => p.slot === slot));
}

/** F11: the entries the strip ALWAYS draws, in order. U2: six now (Pipeline
 * joined), and derived from the slots rather than from an id exclusion list —
 * "permanent" means "has a slot and is not contextual", which is a property a
 * new entry declares rather than a list someone has to remember to update. */
export const PERMANENT_TABS: PanelEntry[] = bySlot(
  STRIP_SLOT_ORDER.filter((s) => s !== 'contextual')
);

/**
 * U2: the card the app opens with, derived from the SAME fact that puts Files
 * first — the user asked for one thing ("make 'Files' default at opening"), so
 * the app stores one thing. A separate `const DEFAULT = 'files'` would be a
 * second place for the answer to live, free to disagree with the strip the
 * first time the lead entry changes.
 */
export const DEFAULT_PANEL: PanelId = MODULE_PANELS.find((p) => p.slot === 'lead')!.id;

/**
 * F11: what the strip draws, stated ONCE so the strip and App cannot disagree
 * about the roster.
 *
 * `hasRemix` is "a remix document exists", which the app already answers with
 * `remixService.getRemixSession(docId) !== null` — the same question
 * `RemixPanel` asks to decide it has something to show. App reads it over the
 * open documents; nothing here invents a second flag to track.
 *
 * U2: ordered by slot, which is what makes "Files first, History last" hold for
 * the contextual roster too — Remix is appended where F11-8 put it (after the
 * permanents) and History still closes the strip.
 */
export function stripTabs(hasRemix: boolean): PanelEntry[] {
  const roster = bySlot(STRIP_SLOT_ORDER);
  return hasRemix ? roster : roster.filter((p) => p.slot !== 'contextual');
}

/** The module column's width — the strip is exactly as wide as the card it
 * sits on, which is what makes the two read as one stacked surface. */
export const MODULE_COLUMN_WIDTH = 348;

/**
 * W1: the tool-host card's width — the OTHER card the strip can sit on.
 *
 * The user's rule: "the module bar and the extended modules must always have
 * the same width." So while a pipeline tool is hosted the strip renders at
 * this width (see `toolHosted` below), and the two numbers a surface in the
 * column can take live side by side in this file — one place to read, one
 * place to change, and the strip structurally CANNOT be handed a width that
 * is neither.
 *
 * The number itself is the host's story, not the strip's: 640 is derived from
 * the widest `DialogShell` stage any hosted tool asks for, the full account
 * (and the derivation test) live with `PipelineToolHost`, and that module
 * re-exports this constant as its own. It is DEFINED here only because the
 * import must run this way — the host already imports `MODULE_COLUMN_WIDTH`
 * from this file, and the strip importing from the host instead would drag
 * the nine dialog components into the layout graph to read one number.
 */
export const TOOL_HOST_WIDTH = 640;

// Vitrine IconSidebar.tsx rail-button anatomy, verbatim except for the tile
// size: eight 42px tiles do not fit across 348px, so the horizontal strip uses
// 34px tiles (8 x 34 = 272, leaving 60px of gap inside the pill). Radius,
// idle chrome text, and the interactive hover/press states in .glass-rail-btn
// (index.css) are untouched. Active = accent-soft tile + accent-ring border +
// accent glyph + glow, the glow derived from the accent token (ruling 2).
//
// F11: the roster is five or six entries now rather than eight, and the tile is
// deliberately NOT grown to fill the slack. The strip's BOX is what the
// packaged smoke measures the E2 layout against (width, top and right, pinned
// there and in ModuleStrip.test), the entries stay `justify-between` inside it,
// and a 34px tile that suited eight icons is not wrong for six — it is the same
// tile, with more air between the entries.
const stripBtn: CSSProperties = {
  width: 34,
  height: 34,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  borderRadius: 10,
  border: '1px solid transparent',
  background: 'transparent',
  color: 'var(--glass-text-chrome-idle)',
  cursor: 'pointer',
  flexShrink: 0,
};

const stripBtnActive: CSSProperties = {
  background: 'var(--accent-soft)',
  border: '1px solid var(--accent-ring)',
  color: 'var(--accent)',
  boxShadow: '0 0 14px var(--accent-ring)',
};

export interface ModuleStripProps {
  /** The open panel card's panel, or null when the column carries no card.
   * F11: this can name a panel the strip draws NO icon for (Spatial,
   * Transcript) — in that state no entry is pressed. */
  activeTab: PanelId | null;
  /** F11: whether any remix document exists, which is the whole rule behind
   * the contextual Remix entry. A prop rather than a subscription of its own:
   * App has to know the same fact anyway (it closes an orphaned Remix card),
   * and one owner of a fact is the difference between two surfaces agreeing
   * and two surfaces racing. */
  hasRemix: boolean;
  /**
   * U2-3: why every entry is refusing clicks right now, or `null`/absent when
   * they are not. Set while a hosted pipeline tool is MID-PASS.
   *
   * The reason is a string rather than a boolean because the honest version of
   * this control is a disabled button that says why. The alternative — dropping
   * the click silently, or hiding the strip — teaches the user nothing about a
   * refusal they did not expect and cannot see the cause of. Why the refusal
   * exists at all is App's to explain (the pass's state is dialog-local and
   * unmounting discards it); the strip only carries the sentence.
   */
  lockedReason?: string | null;
  /**
   * W1: whether the column below currently hosts a pipeline tool. The strip
   * follows the open surface's width — `TOOL_HOST_WIDTH` while this is true,
   * `MODULE_COLUMN_WIDTH` otherwise — because the user ruled that the bar and
   * the open module are never unequal. A boolean rather than a width: the
   * caller states WHICH surface is open, and this file owns what that costs.
   */
  toolHosted?: boolean;
  /** Receives the clicked tab, or null when the click closed the open card. */
  onSelect(tab: PanelId | null): void;
}

export default function ModuleStrip({
  activeTab,
  hasRemix,
  lockedReason = null,
  toolHosted = false,
  onSelect,
}: ModuleStripProps) {
  return (
    <ChromePill
      data-testid="sidebar-tabs"
      className="pointer-events-auto absolute z-20 flex items-center justify-between"
      style={{
        top: 10,
        right: 14,
        // W1: as wide as the surface below — the host card while a tool is
        // hosted, the module column otherwise. `right` is pinned, so the wider
        // strip grows LEFTWARD exactly as the host card does and their edges
        // coincide on both sides. The tiles stay 34px and `justify-between`
        // stays the layout at either width: the wider bar spreads its air
        // between the entries, it does not stretch them.
        width: toolHosted ? TOOL_HOST_WIDTH : MODULE_COLUMN_WIDTH,
        padding: '6px 8px',
      }}
    >
      {/* F11: the roster is a function of the remix state, not a constant. */}
      {stripTabs(hasRemix).map(({ id, label, Icon }) => {
        const isActive = activeTab === id;
        return (
          <button
            key={id}
            type="button"
            aria-label={label}
            title={
              lockedReason ?? (isActive ? `${label} — click to close the card` : label)
            }
            aria-pressed={isActive}
            disabled={lockedReason !== null}
            onClick={() => onSelect(isActive ? null : id)}
            className={`glass-rail-btn${isActive ? ' is-active' : ''}`}
            style={{
              ...stripBtn,
              ...(isActive ? stripBtnActive : null),
              ...(lockedReason !== null ? { opacity: 0.45, cursor: 'default' } : null),
            }}
          >
            <Icon size={17} />
          </button>
        );
      })}
    </ChromePill>
  );
}
