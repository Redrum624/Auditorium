import { useEffect, useState, type ReactNode } from 'react';
import { isTopDialog, nextDialogToken, popDialog, pushDialog } from '../../services/dialogBus';
import { IconTile } from '../UI/glass';

/**
 * Modal overlay chrome shared by the app's dialogs. Renders a dimmed full-screen
 * backdrop with a centered panel. Escape and a backdrop click both cancel via
 * `onClose`, unless `dismissable` is false (Task M7/F12: a dialog can veto
 * dismissal — e.g. RecordDialog while actively recording — so neither Escape
 * nor a stray backdrop click can discard in-progress work).
 *
 * Every instance registers itself in a module-level open-dialog stack
 * (dialogBus) on mount and unregisters on unmount. shortcuts.ts consults the
 * stack to bail out of global shortcuts while any dialog is open (F10); this
 * shell's own Escape handler consults it to close only the TOPMOST of several
 * stacked dialogs (F25) — each shell owns its own document keydown listener,
 * so stopPropagation alone cannot stop a sibling shell from also reacting.
 * Focus trapping is intentionally out of scope for v1.
 *
 * G5 (v1.6 glass UI): the PANEL is a glass card (radius 20/blur/`.glass-card`,
 * Vitrine GlassModal's .92-alpha modal override so body text stays legible
 * over the busy canvas) with the module-card header anatomy — accent IconTile
 * + 12.5/600 title + muted subtitle on the darkened header band — replacing
 * the flat uppercase h2. Behaviour above is untouched; `width` lets each
 * dialog pick its stage (mockup: simple confirms stay 360, Auto-Remix is 600).
 */
export default function DialogShell({
  title,
  subtitle,
  icon,
  width = 360,
  onClose,
  children,
  dismissable = true,
}: {
  title: string;
  /** Muted state subtitle under the title (e.g. "song.wav · 1:04"). */
  subtitle?: string;
  /** ~15px lucide glyph for the header's accent icon tile (ruling 3: lucide only). */
  icon?: ReactNode;
  /** Card width in px; grows per-dialog (default 360). */
  width?: number;
  onClose: () => void;
  children: ReactNode;
  dismissable?: boolean;
}) {
  // Minting the token is a pure counter bump (safe under StrictMode's
  // double-render); registering it on the stack happens only from the effect
  // below, whose mount/cleanup are always paired 1:1 — see dialogBus.ts.
  const [token] = useState(nextDialogToken);
  useEffect(() => {
    pushDialog(token);
    return () => popDialog(token);
  }, [token]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (!dismissable || !isTopDialog(token)) return;
      e.stopPropagation();
      onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose, dismissable, token]);

  const dismissViaBackdrop = () => {
    if (dismissable) onClose();
  };

  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center"
      style={{
        background: 'rgba(5, 5, 8, 0.6)',
        backdropFilter: 'blur(8px)',
        WebkitBackdropFilter: 'blur(8px)',
      }}
      data-testid="dialog-overlay"
      onMouseDown={dismissViaBackdrop}
    >
      <div
        role="dialog"
        aria-label={title}
        className="glass-card dc-rise flex max-h-[86vh] flex-col overflow-hidden"
        style={{ width, background: 'rgba(15, 15, 19, 0.92)' }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div
          className="flex flex-shrink-0 items-center"
          style={{
            padding: '13px 16px',
            gap: 11,
            background: 'rgba(0, 0, 0, 0.3)',
            borderBottom: '1px solid var(--glass-border)',
          }}
        >
          {icon && <IconTile data-testid="dialog-icon">{icon}</IconTile>}
          <div className="min-w-0 flex-1">
            <div
              style={{
                fontSize: 12.5,
                fontWeight: 600,
                color: 'var(--glass-text-title)',
                lineHeight: 1.25,
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
              }}
            >
              {title}
            </div>
            {subtitle && (
              <div
                style={{
                  fontSize: 10.5,
                  color: 'var(--glass-text-muted)',
                  lineHeight: 1.35,
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                }}
              >
                {subtitle}
              </div>
            )}
          </div>
        </div>
        <div className="flex-1 overflow-y-auto" style={{ padding: 16 }}>
          {children}
        </div>
      </div>
    </div>
  );
}
