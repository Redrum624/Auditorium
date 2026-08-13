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
export type SidebarTab =
  | 'files'
  | 'effects'
  | 'markers'
  | 'history'
  | 'properties'
  | 'remix'
  | 'spatial'
  | 'transcript';

export const SIDEBAR_TABS: { id: SidebarTab; label: string; Icon: LucideIcon }[] = [
  { id: 'files', label: 'Files', Icon: Folder },
  { id: 'effects', label: 'Effects', Icon: Sparkles },
  { id: 'markers', label: 'Markers', Icon: Flag },
  { id: 'history', label: 'History', Icon: HistoryIcon },
  { id: 'properties', label: 'Properties', Icon: Info },
  { id: 'remix', label: 'Remix', Icon: Shuffle },
  // F5 — the spatial positioner (stereo projection; lucide line icon, never
  // emoji). A sidebar tab rather than a track-header popover because the
  // positioner is playhead-scoped, not row-scoped: it follows the transport
  // and switches tracks from its own selector, and the 348px card gives the
  // stage room the 96px track row never could.
  { id: 'spatial', label: 'Spatial', Icon: Orbit },
  // F4b — the transcript (lucide line icon, never emoji). A sidebar tab
  // rather than a dialog because a transcript is read ALONGSIDE the audio:
  // rows are scrubbed against the waveform one at a time, over minutes, and a
  // modal would have to be dismissed to do the one thing it is for.
  { id: 'transcript', label: 'Transcript', Icon: Captions },
];

/** The module column's width — the strip is exactly as wide as the card it
 * sits on, which is what makes the two read as one stacked surface. */
export const MODULE_COLUMN_WIDTH = 348;

// Vitrine IconSidebar.tsx rail-button anatomy, verbatim except for the tile
// size: eight 42px tiles do not fit across 348px, so the horizontal strip uses
// 34px tiles (8 x 34 = 272, leaving 60px of gap inside the pill). Radius,
// idle chrome text, and the interactive hover/press states in .glass-rail-btn
// (index.css) are untouched. Active = accent-soft tile + accent-ring border +
// accent glyph + glow, the glow derived from the accent token (ruling 2).
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
  /** The open panel card's tab, or null when the column carries no card. */
  activeTab: SidebarTab | null;
  /** Receives the clicked tab, or null when the click closed the open card. */
  onSelect(tab: SidebarTab | null): void;
}

export default function ModuleStrip({ activeTab, onSelect }: ModuleStripProps) {
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
      {SIDEBAR_TABS.map(({ id, label, Icon }) => {
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
