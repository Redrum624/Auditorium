import { useEffect, useRef, useState } from 'react';
import type { MenuCommand } from '../../services/menuActions';
import { getMenuSections, runCommand } from '../../services/menuActions';
import { useAppStore } from '../../stores/appStore';
import { useHistoryVersion } from '../../services/undoHistory';

export default function MenuBar() {
  const [openTitle, setOpenTitle] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
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
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
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

  async function handleItemClick(cmd: MenuCommand) {
    setOpenTitle(null);
    await runCommand(cmd.id);
  }

  return (
    <div ref={rootRef} className="flex h-full items-center gap-1">
      {sections.map((section) => (
        <div key={section.title} className="relative flex h-full items-center">
          <button
            type="button"
            className={`chrome-menu-btn ${openTitle === section.title ? 'is-open' : ''}`}
            onClick={() => setOpenTitle((t) => (t === section.title ? null : section.title))}
          >
            {section.title}
          </button>
          {openTitle === section.title && (
            <div className="chrome-menu-dropdown absolute left-0 top-full z-50 min-w-[200px] py-1">
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
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
