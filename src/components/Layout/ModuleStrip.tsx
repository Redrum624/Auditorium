import type { CSSProperties } from 'react';
import { Captions, Flag, Folder, History as HistoryIcon, Info, Orbit, Shuffle, Sparkles } from 'lucide-react';
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
  | 'markers'
  | 'history'
  | 'properties'
  | 'remix'
  | 'spatial'
  | 'transcript';

export interface PanelEntry {
  id: PanelId;
  label: string;
  Icon: LucideIcon;
}

// F11: the CARD's registry — every panel it can render, icons or not.
export const MODULE_PANELS: PanelEntry[] = [
  { id: 'files', label: 'Files', Icon: Folder },
  { id: 'effects', label: 'Effects', Icon: Sparkles },
  { id: 'markers', label: 'Markers', Icon: Flag },
  { id: 'history', label: 'History', Icon: HistoryIcon },
  { id: 'properties', label: 'Properties', Icon: Info },
  // F11: contextual — an icon only while a remix document exists (see
  // `stripTabs`). Also reached the moment one is created, through
  // `focusRemixPanel()`.
  { id: 'remix', label: 'Remix', Icon: Shuffle },
  // F5 — the spatial positioner (stereo projection; lucide line icon, never
  // emoji). F11: no strip icon any more — it is reached by the
  // `spatial.position` command (Pipeline > Mix, and the Effects card's Mix
  // section). The panel is unchanged, and it is still a CARD rather than a
  // track-header popover for F5's own reason: the positioner is
  // playhead-scoped, not row-scoped, and the 348px card gives the stage room
  // the 96px track row never could.
  { id: 'spatial', label: 'Spatial', Icon: Orbit },
  // F4b — the transcript (lucide line icon, never emoji). F11: no strip icon
  // any more — the Transcribe tool shows it (`edit.transcribe` reveals an
  // existing transcript instead of re-running the model). Still a card rather
  // than a dialog for F4b's own reason: a transcript is read ALONGSIDE the
  // audio, one row scrubbed at a time over minutes, and a modal would have to
  // be dismissed to do the one thing it is for.
  { id: 'transcript', label: 'Transcript', Icon: Captions },
];

/** F11: the five entries the strip ALWAYS draws, in order. */
export const PERMANENT_TABS: PanelEntry[] = MODULE_PANELS.filter(
  (p) => p.id !== 'remix' && p.id !== 'spatial' && p.id !== 'transcript'
);

const REMIX_TAB = MODULE_PANELS.find((p) => p.id === 'remix')!;

/**
 * F11: what the strip draws, stated ONCE so the strip and App cannot disagree
 * about the roster.
 *
 * `hasRemix` is "a remix document exists", which the app already answers with
 * `remixService.getRemixSession(docId) !== null` — the same question
 * `RemixPanel` asks to decide it has something to show. App reads it over the
 * open documents; nothing here invents a second flag to track.
 */
export function stripTabs(hasRemix: boolean): PanelEntry[] {
  return hasRemix ? [...PERMANENT_TABS, REMIX_TAB] : PERMANENT_TABS;
}

/** The module column's width — the strip is exactly as wide as the card it
 * sits on, which is what makes the two read as one stacked surface. */
export const MODULE_COLUMN_WIDTH = 348;

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
  /** Receives the clicked tab, or null when the click closed the open card. */
  onSelect(tab: PanelId | null): void;
}

export default function ModuleStrip({ activeTab, hasRemix, onSelect }: ModuleStripProps) {
  return (
    <ChromePill
      data-testid="sidebar-tabs"
      className="pointer-events-auto absolute z-20 flex items-center justify-between"
      style={{
        top: 10,
        right: 14,
        width: MODULE_COLUMN_WIDTH,
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
            title={isActive ? `${label} — click to close the card` : label}
            aria-pressed={isActive}
            onClick={() => onSelect(isActive ? null : id)}
            className={`glass-rail-btn${isActive ? ' is-active' : ''}`}
            style={{ ...stripBtn, ...(isActive ? stripBtnActive : null) }}
          >
            <Icon size={17} />
          </button>
        );
      })}
    </ChromePill>
  );
}
