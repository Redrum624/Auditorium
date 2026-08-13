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
 * - `onModuleLockChange` is the report back up: "a pass is running that leaving
 *   this module would destroy". By default that is `!dismissable` — the flag
 *   every one of the nine already hands the shell to refuse Escape and a
 *   backdrop click mid-run — so nothing new had to be published, because the
 *   fact was already crossing this boundary.
 *
 * Why the report is the LOCK rather than `dismissable` itself. The two coincide
 * almost everywhere, but they are different questions: "may this dialog be
 * discarded" versus "must the app be held while it finishes". Auto-Remix starts
 * a tempo analysis in a mount effect, so it is born un-dismissable — and
 * equating the two greyed the whole module strip and suspended the keyboard the
 * instant the tool opened, for a pass the user had not started. A dialog can
 * now say so with `DialogShell`'s `moduleLock` prop; everything else keeps the
 * default and never learns this distinction exists.
 */
export interface DialogHostApi {
  /** Called by the hosted `DialogShell` whenever the lock changes, and with
   * `false` on unmount — a host left believing a pass is still running would
   * grey the module strip and suspend the shortcuts for the session. */
  onModuleLockChange(locked: boolean): void;
}

/** `null` means "not hosted", which is the default everywhere. */
export const DialogHostContext = createContext<DialogHostApi | null>(null);

/** The hosted-ness a `DialogShell` reads, or `null` when it is a modal. */
export function useDialogHost(): DialogHostApi | null {
  return useContext(DialogHostContext);
}

export function DialogHostProvider({
  onModuleLockChange,
  children,
}: {
  onModuleLockChange(locked: boolean): void;
  children: ReactNode;
}) {
  // Memoised on the callback so the context value is stable across the host's
  // own re-renders: the shell publishes from an effect keyed on this object,
  // and a fresh object per render would re-publish on every paint.
  const api = useMemo<DialogHostApi>(() => ({ onModuleLockChange }), [onModuleLockChange]);
  return <DialogHostContext.Provider value={api}>{children}</DialogHostContext.Provider>;
}
