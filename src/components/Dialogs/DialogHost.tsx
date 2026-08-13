import { createContext, useContext, useMemo, type ReactNode } from 'react';

/**
 * U2-3 — the mounting seam that lets a dialog render as a CARD instead of a
 * modal, without any dialog knowing about it.
 *
 * The user asked that selecting a pipeline "open the module in the extended
 * modules instead of a modal". Nine tools would have had to be rewritten to
 * obey that literally — nine bodies, nine sets of tests, and a head-on
 * collision with the concurrent rewrite of `CoverChainDialog`'s internals. But
 * none of the nine actually decides it is modal: each renders its body inside
 * `DialogShell`, and the SHELL is where the backdrop, the fixed overlay and the
 * open-dialog stack live. So the seam is one context read in one shared file,
 * and every dialog inherits the new presentation by being unchanged.
 *
 * The context carries exactly one thing in each direction:
 *
 * - Its PRESENCE is the instruction ("you are hosted"). A dialog rendered
 *   outside a provider is the modal it always was, byte for byte.
 * - `onDismissableChange` is the report back up. `dismissable={!busy}` is the
 *   flag every one of the nine already hands the shell to refuse Escape and a
 *   backdrop click mid-run; hosted, the host reads that same flag to refuse its
 *   own ✕ and to lock the module strip. Nothing new had to be published,
 *   because the fact was already crossing this boundary.
 */
export interface DialogHostApi {
  /** Called by the hosted `DialogShell` whenever the dialog's `dismissable`
   * changes, and with `true` on unmount — a host left believing a pass is
   * still running would lock the module strip for the session. */
  onDismissableChange(dismissable: boolean): void;
}

/** `null` means "not hosted", which is the default everywhere. */
export const DialogHostContext = createContext<DialogHostApi | null>(null);

/** The hosted-ness a `DialogShell` reads, or `null` when it is a modal. */
export function useDialogHost(): DialogHostApi | null {
  return useContext(DialogHostContext);
}

export function DialogHostProvider({
  onDismissableChange,
  children,
}: {
  onDismissableChange(dismissable: boolean): void;
  children: ReactNode;
}) {
  // Memoised on the callback so the context value is stable across the host's
  // own re-renders: the shell publishes from an effect keyed on this object,
  // and a fresh object per render would re-publish on every paint.
  const api = useMemo<DialogHostApi>(() => ({ onDismissableChange }), [onDismissableChange]);
  return <DialogHostContext.Provider value={api}>{children}</DialogHostContext.Provider>;
}
