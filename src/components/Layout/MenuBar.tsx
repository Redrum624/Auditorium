import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { MenuCommand } from '../../services/menuActions';
import { getMenuSections, runCommand } from '../../services/menuActions';
import { useAppStore } from '../../stores/appStore';
import { useHistoryVersion } from '../../services/undoHistory';

// F11: the air kept between a clamped dropdown's bottom edge and the window
// frame, so a scrolling menu never sits flush against it.
const DROPDOWN_VIEWPORT_MARGIN = 8;
// F11: a dropdown is never clamped below this, however short the window —
// under it the panel stops being a menu and becomes a one-row scroller.
const DROPDOWN_MIN_HEIGHT = 96;
// F11: unchanged from the `z-50` the dropdown carried while it lived inside the
// titlebar (itself `relative z-50`), so the z-order against the glass chrome
// (z-20) and the dialogs (z-40) is exactly what it was.
const DROPDOWN_Z_INDEX = 50;

// F11: where an open dropdown hangs, measured from the section's own wrapper
// (the box `top-full` used to resolve against) at the moment it opens.
interface DropdownAnchor {
  left: number;
  top: number;
  maxHeight: number;
}

export default function MenuBar() {
  const [openTitle, setOpenTitle] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  // F11: the panel is portalled to document.body, so it is NOT inside
  // `rootRef`; the outside-click guard has to know about it separately or a
  // mousedown on a menu row would close the menu before the click landed.
  const dropdownRef = useRef<HTMLDivElement>(null);
  // F11: one wrapper per section, so the anchor is measured from the same box
  // the old `absolute top-full` positioned against.
  const anchorsRef = useRef(new Map<string, HTMLDivElement | null>());
  const [anchor, setAnchor] = useState<DropdownAnchor | null>(null);
  // Subscribe so item.enabled(...) is recomputed whenever store state changes.
  useAppStore((s) => s);
  // R3: session undo entries change no appStore state (a clip drag writes the
  // SESSION store), so Edit > Undo/Redo enablement in the multitrack view
  // also needs the history's own version counter. Document edits piggybacked
  // on appStore re-renders and never needed this.
  useHistoryVersion();
  const sections = getMenuSections();

  useEffect(() => {
    function onMouseDown(e: MouseEvent) {
      const target = e.target as Node;
      const inBar = rootRef.current?.contains(target) ?? false;
      // F11: second containment check — see `dropdownRef`.
      const inDropdown = dropdownRef.current?.contains(target) ?? false;
      if (rootRef.current && !inBar && !inDropdown) {
        setOpenTitle(null);
      }
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpenTitle(null);
    }
    document.addEventListener('mousedown', onMouseDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onMouseDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, []);

  // F11: measures the space actually left under the bar. The clamp is a pure
  // function of the wrapper's rect and the window's height, so resizing the
  // window while a menu is open re-derives it rather than keeping a stale one.
  function measureAnchor(title: string): DropdownAnchor {
    const rect = anchorsRef.current.get(title)?.getBoundingClientRect();
    const left = rect?.left ?? 0;
    const top = rect?.bottom ?? 0;
    return {
      left,
      top,
      maxHeight: Math.max(
        DROPDOWN_MIN_HEIGHT,
        window.innerHeight - top - DROPDOWN_VIEWPORT_MARGIN
      ),
    };
  }

  // F11: re-anchor on resize while a menu is open.
  useEffect(() => {
    if (openTitle === null) return;
    const onResize = () => setAnchor(measureAnchor(openTitle));
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openTitle]);

  // F11: toggling measures BEFORE the panel renders, so it is positioned on its
  // first paint rather than flashing at 0,0 and jumping.
  function toggleSection(title: string): void {
    if (openTitle === title) {
      setOpenTitle(null);
      return;
    }
    setAnchor(measureAnchor(title));
    setOpenTitle(title);
  }

  async function handleItemClick(cmd: MenuCommand) {
    setOpenTitle(null);
    await runCommand(cmd.id);
  }

  return (
    <div ref={rootRef} className="flex h-full items-center gap-1">
      {sections.map((section) => (
        <div
          key={section.title}
          className="relative flex h-full items-center"
          // F11: the box the dropdown is anchored to.
          ref={(el) => {
            anchorsRef.current.set(section.title, el);
          }}
        >
          <button
            type="button"
            className={`chrome-menu-btn ${openTitle === section.title ? 'is-open' : ''}`}
            onClick={() => toggleSection(section.title)}
          >
            {section.title}
          </button>
          {/* F11-5: the panel is PORTALLED to document.body and positioned
              `fixed`. Before this it was `absolute` inside the titlebar: that
              never changed an ancestor's layout box, but nothing between it and
              the viewport sets `overflow: hidden` (html/body/#root are all
              height:100% and visible), so a panel taller than the window
              extended the DOCUMENT's scrollable overflow region and made the
              whole app scroll — the "new space at the bottom pushing everything
              up" the user reported. A fixed box generates no document
              scrollbar, and the portal also escapes the titlebar's
              `backdrop-filter`, which would otherwise make itself the
              containing block for fixed descendants and reinstate the bug. */}
          {openTitle === section.title &&
            anchor &&
            createPortal(
              <div
                ref={dropdownRef}
                data-testid="menu-dropdown"
                data-menu-title={section.title}
                className="chrome-menu-dropdown min-w-[200px] py-1"
                style={{
                  // Inline, not Tailwind classes: these three ARE the fix, and
                  // a class cannot carry a measured value.
                  position: 'fixed',
                  left: anchor.left,
                  top: anchor.top,
                  maxHeight: anchor.maxHeight,
                  overflowY: 'auto',
                  zIndex: DROPDOWN_Z_INDEX,
                }}
              >
                {section.items.map((item, i) =>
                  item === 'separator' ? (
                    <div
                      key={`separator-${i}`}
                      className="my-1 h-px"
                      style={{ background: 'var(--gray-700)' }}
                    />
                  ) : (
                    <button
                      key={item.id}
                      type="button"
                      disabled={!item.enabled(useAppStore.getState())}
                      className="chrome-menu-item flex w-full items-center justify-between gap-6 text-left"
                      onClick={() => handleItemClick(item)}
                    >
                      <span>{item.label}</span>
                      {item.shortcut && (
                        <span style={{ color: 'var(--glass-text-muted)' }}>{item.shortcut}</span>
                      )}
                    </button>
                  )
                )}
              </div>,
              document.body
            )}
        </div>
      ))}
    </div>
  );
}
