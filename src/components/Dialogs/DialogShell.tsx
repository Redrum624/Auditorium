import { useEffect, type ReactNode } from 'react';

/**
 * Modal overlay chrome shared by the app's dialogs. Renders a dimmed full-screen
 * backdrop with a centered panel. Escape and a backdrop click both cancel via
 * `onClose`. Focus trapping is intentionally out of scope for v1.
 */
export default function DialogShell({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/50"
      data-testid="dialog-overlay"
      onMouseDown={onClose}
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
