import { useEffect, useState, type ReactNode } from 'react';
import { X } from 'lucide-react';
import { isTopDialog, nextDialogToken, popDialog, pushDialog } from '../../services/dialogBus';
import { useDialogHost } from './DialogHost';
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
 *
 * U2-3: everything above describes the MODAL presentation, and it is still
 * exactly what an unwrapped `DialogShell` renders. Wrapped in a
 * `DialogHostProvider` (see DialogHost.tsx) the same shell renders the same
 * header and body as an in-flow CARD instead: no fixed overlay, no backdrop, no
 * entry on the open-dialog stack and no Escape handler, so the stage behind it
 * stays fully live. Which presentation applies is decided by the caller's
 * mounting, never by the dialog — that is what let nine pipeline tools move out
 * of their modals without one of them being edited.
 *
 * Note what the header already was: "the module-card header anatomy". The
 * hosted branch draws the same three elements plus a ✕, because the modal
 * header had been a copy of the module card's since G5 — the card presentation
 * did not need inventing, only unwrapping.
 */
export default function DialogShell({
  title,
  subtitle,
  icon,
  width = 360,
  onClose,
  children,
  dismissable = true,
  moduleLock,
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
  /**
   * U2-3, hosted only: whether the module column must be HELD — the strip
   * greyed and the global shortcuts suspended — because a pass is running that
   * leaving would destroy. Defaults to `!dismissable`, which is right for eight
   * of the nine pipeline tools.
   *
   * It exists for the ninth. Auto-Remix starts a tempo analysis in a mount
   * effect, so it is born un-dismissable, and defaulting greyed the whole app
   * the instant the tool opened for a pass the user had not started. Passing
   * this narrows the lock to the passes the USER starts, without touching what
   * `dismissable` means: the ✕, Escape and the backdrop still follow that.
   * Ignored entirely in the modal presentation.
   */
  moduleLock?: boolean;
}) {
  // U2-3: `null` unless something mounted this inside a DialogHostProvider.
  // Every conditional below branches on it; the hooks themselves are called
  // unconditionally, so the hook order is identical in both presentations.
  const host = useDialogHost();
  const hosted = host !== null;

  // Minting the token is a pure counter bump (safe under StrictMode's
  // double-render); registering it on the stack happens only from the effect
  // below, whose mount/cleanup are always paired 1:1 — see dialogBus.ts.
  const [token] = useState(nextDialogToken);
  useEffect(() => {
    // U2-3: a hosted tool does NOT join the stack. `shortcuts.ts` bails out of
    // every global shortcut while that stack is non-empty, and the point of
    // hosting is that the user can still play, scrub and select behind the
    // tool. The stack's other reader, `isTopDialog`, is about Escape ordering
    // between stacked modals, which a card is not part of either.
    if (hosted) return;
    pushDialog(token);
    return () => popDialog(token);
  }, [token, hosted]);

  useEffect(() => {
    // U2-3: no document-level Escape handler while hosted. Escape belongs to
    // the stage (it clears the selection there), and a card that swallowed it
    // would be a focus trap wearing a different shape. The ✕ is the dismissal.
    if (hosted) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (!dismissable || !isTopDialog(token)) return;
      e.stopPropagation();
      onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose, dismissable, token, hosted]);

  // U2-3: publish the module LOCK to the host — `!dismissable` unless the
  // dialog narrowed it — and release it on unmount so a host cannot be stranded
  // holding the strip and the shortcuts for the rest of the session.
  const locked = moduleLock ?? !dismissable;
  useEffect(() => {
    if (!host) return;
    host.onModuleLockChange(locked);
    return () => host.onModuleLockChange(false);
  }, [host, locked]);

  const dismissViaBackdrop = () => {
    if (dismissable) onClose();
  };

  if (host) {
    return (
      <section
        aria-label={title}
        data-testid="hosted-tool"
        className="flex min-h-0 flex-1 flex-col"
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
          {/* The module card's own close control, and the same rule the modal
              backdrop follows: `dismissable === false` is the dialog refusing
              to be discarded mid-run, and it refuses here too. Disabled with
              the reason in the tooltip rather than absent — a control that
              vanishes teaches nothing. */}
          <button
            type="button"
            data-testid="hosted-tool-close"
            aria-label={`Close ${title}`}
            title={
              dismissable ? 'Close this tool' : 'This pass is running — it cannot be closed yet'
            }
            disabled={!dismissable}
            onClick={onClose}
            className="glass-rail-btn flex shrink-0 items-center justify-center"
            style={{
              width: 22,
              height: 22,
              borderRadius: 7,
              border: '1px solid transparent',
              background: 'transparent',
              color: 'var(--glass-text-chrome-idle)',
              cursor: dismissable ? 'pointer' : 'default',
              opacity: dismissable ? 1 : 0.5,
            }}
          >
            <X size={13} />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto" style={{ padding: 16 }}>
          {children}
        </div>
      </section>
    );
  }

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
