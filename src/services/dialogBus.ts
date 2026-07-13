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

export function registerDialogSetters(setters: {
  openExportDialog: OpenSetter;
  openNewFileDialog: OpenSetter;
  openEffectDialog: OpenEffectSetter;
  openConvertDialog: OpenConvertSetter;
}): () => void {
  openExport = setters.openExportDialog;
  openNewFile = setters.openNewFileDialog;
  openEffect = setters.openEffectDialog;
  openConvert = setters.openConvertDialog;
  return () => {
    openExport = null;
    openNewFile = null;
    openEffect = null;
    openConvert = null;
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
