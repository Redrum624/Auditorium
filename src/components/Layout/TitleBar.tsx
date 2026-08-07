import { useEffect, useState, type CSSProperties } from 'react';
import { Copy, Minus, Square, X } from 'lucide-react';
import MenuBar from './MenuBar';

/** `-webkit-app-region` isn't in the standard CSSProperties typing; this cast
 * scopes the extra property to just the two style objects below. */
type AppRegionStyle = CSSProperties & { WebkitAppRegion?: 'drag' | 'no-drag' };

/** The bar itself is the drag region (Vitrine's MenuBar.tsx anatomy: the
 * wordmark and every empty stretch move the window); the menus and the window
 * buttons are no-drag islands so they stay clickable. */
const dragStyle: AppRegionStyle = {
  WebkitAppRegion: 'drag',
  background: 'var(--glass-bg-chrome)',
  borderBottom: '1px solid var(--glass-border)',
  backdropFilter: 'blur(var(--glass-blur-chrome))',
  WebkitBackdropFilter: 'blur(var(--glass-blur-chrome))',
};
const noDragStyle: AppRegionStyle = { WebkitAppRegion: 'no-drag' };

const wordmarkStyle: CSSProperties = {
  color: 'var(--glass-text-title)',
  fontSize: 12,
  fontWeight: 600,
  letterSpacing: '0.14em',
  whiteSpace: 'nowrap',
};

export default function TitleBar() {
  const [isMaximized, setIsMaximized] = useState(false);

  useEffect(() => {
    const unsubscribe = window.electronAPI?.onWindowMaximized((max) => setIsMaximized(max));
    return () => unsubscribe?.();
  }, []);

  return (
    <div className="relative z-50 flex h-9 shrink-0 items-center" style={dragStyle}>
      {/* Wordmark — part of the drag region (Vitrine keeps its logo draggable). */}
      <div className="flex items-center pl-4 pr-3.5">
        <span style={wordmarkStyle}>◈ AUDITORIUM</span>
      </div>
      {/* Menus — no-drag island. */}
      <div className="h-full" style={noDragStyle}>
        <MenuBar />
      </div>
      {/* Spacer — draggable dead zone up to the window buttons. */}
      <div className="h-full flex-1" />
      {/* Window controls — no-drag island; Vitrine sizes (Minus 16 / Square 14 /
          Copy 14 / X 16), routed through preload so ✕ goes win.close() ->
          closeGuard.handleClose, never a raw destroy. */}
      <div className="flex h-full items-center" style={noDragStyle}>
        <button
          type="button"
          aria-label="Minimize"
          className="chrome-winbtn flex h-full w-11 items-center justify-center"
          onClick={() => window.electronAPI?.windowMinimize()}
        >
          <Minus size={16} />
        </button>
        <button
          type="button"
          aria-label={isMaximized ? 'Restore' : 'Maximize'}
          className="chrome-winbtn flex h-full w-11 items-center justify-center"
          onClick={() => window.electronAPI?.windowToggleMaximize()}
        >
          {isMaximized ? <Copy size={14} className="rotate-180" /> : <Square size={14} />}
        </button>
        <button
          type="button"
          aria-label="Close"
          className="chrome-winbtn flex h-full w-11 items-center justify-center"
          onClick={() => window.electronAPI?.windowClose()}
        >
          <X size={16} />
        </button>
      </div>
    </div>
  );
}
