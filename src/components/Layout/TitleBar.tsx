import { useEffect, useState, type CSSProperties } from 'react';
import { Copy, Minus, Square, X } from 'lucide-react';
import MenuBar from './MenuBar';

/** `-webkit-app-region` isn't in the standard CSSProperties typing; this cast
 * scopes the extra property to just the two style objects below. */
type AppRegionStyle = CSSProperties & { WebkitAppRegion?: 'drag' | 'no-drag' };

const dragStyle: AppRegionStyle = { WebkitAppRegion: 'drag' };
const noDragStyle: AppRegionStyle = { WebkitAppRegion: 'no-drag' };

export default function TitleBar() {
  const [isMaximized, setIsMaximized] = useState(false);

  useEffect(() => {
    const unsubscribe = window.electronAPI?.onWindowMaximized((max) => setIsMaximized(max));
    return () => unsubscribe?.();
  }, []);

  return (
    <div
      className="flex h-9 items-center justify-between border-b border-[#3a3a42] bg-[#1a1a1e] text-[#d4d4d8]"
      style={dragStyle}
    >
      <div className="flex h-full items-center">
        <div className="flex items-center gap-2 px-3 text-sm font-medium" style={noDragStyle}>
          <span className="h-3.5 w-3.5 rounded-sm bg-[#26c6da]" aria-hidden="true" />
          <span>Auditorium</span>
        </div>
        <div style={noDragStyle}>
          <MenuBar />
        </div>
      </div>
      <div className="flex h-full items-center" style={noDragStyle}>
        <button
          type="button"
          aria-label="Minimize"
          className="flex h-9 w-11 items-center justify-center hover:bg-[#2e2e34]"
          onClick={() => window.electronAPI?.windowMinimize()}
        >
          <Minus size={14} />
        </button>
        <button
          type="button"
          aria-label={isMaximized ? 'Restore' : 'Maximize'}
          className="flex h-9 w-11 items-center justify-center hover:bg-[#2e2e34]"
          onClick={() => window.electronAPI?.windowToggleMaximize()}
        >
          {isMaximized ? <Copy size={12} /> : <Square size={12} />}
        </button>
        <button
          type="button"
          aria-label="Close"
          className="flex h-9 w-11 items-center justify-center hover:bg-[#e81123] hover:text-white"
          onClick={() => window.electronAPI?.windowClose()}
        >
          <X size={14} />
        </button>
      </div>
    </div>
  );
}
