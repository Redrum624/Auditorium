import { useEffect, useRef, useState } from 'react';
import type { MenuCommand } from '../../services/menuActions';
import { getMenuSections, runCommand } from '../../services/menuActions';
import { useAppStore } from '../../stores/appStore';

export default function MenuBar() {
  const [openTitle, setOpenTitle] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  // Subscribe so item.enabled(...) is recomputed whenever store state changes.
  useAppStore((s) => s);
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
    <div ref={rootRef} className="flex h-full items-center text-sm">
      {sections.map((section) => (
        <div key={section.title} className="relative h-full">
          <button
            type="button"
            className={`h-full px-3 hover:bg-[#2e2e34] ${
              openTitle === section.title ? 'bg-[#2e2e34]' : ''
            }`}
            onClick={() => setOpenTitle((t) => (t === section.title ? null : section.title))}
          >
            {section.title}
          </button>
          {openTitle === section.title && (
            <div className="absolute left-0 top-full z-50 min-w-[200px] border border-[#3a3a42] bg-[#232328] py-1 shadow-lg">
              {section.items.map((item, i) =>
                item === 'separator' ? (
                  <div key={`separator-${i}`} className="my-1 h-px bg-[#3a3a42]" />
                ) : (
                  <button
                    key={item.id}
                    type="button"
                    disabled={!item.enabled(useAppStore.getState())}
                    className="flex w-full items-center justify-between gap-6 px-3 py-1 text-left text-[#d4d4d8] enabled:hover:bg-[#2e2e34] disabled:cursor-default disabled:text-[#8b8b92] disabled:opacity-50"
                    onClick={() => handleItemClick(item)}
                  >
                    <span>{item.label}</span>
                    {item.shortcut && <span className="text-[#8b8b92]">{item.shortcut}</span>}
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
