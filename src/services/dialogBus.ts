// Tiny typed bus decoupling the file.* / effect.* menu commands from the React
// dialog state. App.tsx registers its setState setters via `registerDialogSetters`
// on mount; the commands call `openExportDialog()` / `openNewFileDialog()` /
// `openEffectDialog(id)` without importing React or reaching into component state.

export type ConvertMode = 'sampleRate' | 'channels';

type OpenSetter = () => void;
type OpenEffectSetter = (effectId: string) => void;
type OpenConvertSetter = (mode: ConvertMode) => void;

let openExport: OpenSetter | null = null;
let openNewFile: OpenSetter | null = null;
let openEffect: OpenEffectSetter | null = null;
let openConvert: OpenConvertSetter | null = null;
let openRecord: OpenSetter | null = null;

export function registerDialogSetters(setters: {
  openExportDialog: OpenSetter;
  openNewFileDialog: OpenSetter;
  openEffectDialog: OpenEffectSetter;
  openConvertDialog: OpenConvertSetter;
  openRecordDialog: OpenSetter;
}): () => void {
  openExport = setters.openExportDialog;
  openNewFile = setters.openNewFileDialog;
  openEffect = setters.openEffectDialog;
  openConvert = setters.openConvertDialog;
  openRecord = setters.openRecordDialog;
  return () => {
    openExport = null;
    openNewFile = null;
    openEffect = null;
    openConvert = null;
    openRecord = null;
  };
}

export function openExportDialog(): void {
  openExport?.();
}

export function openNewFileDialog(): void {
  openNewFile?.();
}

export function openEffectDialog(effectId: string): void {
  openEffect?.(effectId);
}

export function openConvertDialog(mode: ConvertMode): void {
  openConvert?.(mode);
}

export function openRecordDialog(): void {
  openRecord?.();
}

// --- Open-dialog stack (Task M7: F10/F25) ---------------------------------
// DialogShell pushes a token when it mounts and pops it on unmount, LIFO by
// mount order. shortcuts.ts calls `hasOpenDialog()` to bail out of every
// global shortcut while ANY dialog is open (F10): ExportDialog/EffectDialog/
// ConvertDialog resolve their target document from the LIVE activeDocumentId
// at confirm time, so a shortcut firing behind an open dialog (e.g. Ctrl+O
// while Export is open) would silently act on/replace the wrong document.
// DialogShell's own Escape handler calls `isTopDialog(token)` so with two
// dialogs stacked, one Escape press closes only the topmost (F25) — each
// DialogShell installs its own document keydown listener and stopPropagation
// cannot stop sibling listeners, so the ordering has to be an explicit stack
// check instead.

let nextDialogToken = 1;
const openDialogStack: number[] = [];

/** Registers a newly-opened dialog on top of the stack; returns its token. */
export function pushDialog(): number {
  const token = nextDialogToken++;
  openDialogStack.push(token);
  return token;
}

/** Unregisters a dialog (called on unmount). No-ops if already removed. */
export function popDialog(token: number): void {
  const index = openDialogStack.indexOf(token);
  if (index !== -1) openDialogStack.splice(index, 1);
}

/** True while at least one dialog is open. */
export function hasOpenDialog(): boolean {
  return openDialogStack.length > 0;
}

/** True when `token` is the most-recently-opened (topmost) dialog. */
export function isTopDialog(token: number): boolean {
  return openDialogStack[openDialogStack.length - 1] === token;
}
