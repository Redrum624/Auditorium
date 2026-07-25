import { useEffect, useState, type ReactNode } from 'react';
import { isTopDialog, nextDialogToken, popDialog, pushDialog } from '../../services/dialogBus';

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
 */
export default function DialogShell({
  title,
  onClose,
  children,
  dismissable = true,
}: {
  title: string;
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
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/50"
      data-testid="dialog-overlay"
      onMouseDown={dismissViaBackdrop}
    >
      <div
        role="dialog"
        aria-label={title}
        className="w-[360px] rounded border border-[#3a3a42] bg-[#232328] p-4 shadow-xl"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <h2 className="mb-4 text-sm font-semibold uppercase tracking-wide text-[#d4d4d8]">
          {title}
        </h2>
        {children}
      </div>
    </div>
  );
}
