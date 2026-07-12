// Tiny typed bus decoupling the file.* menu commands from the React dialog state.
// App.tsx registers its setState setters via `registerDialogSetters` on mount;
// the commands call `openExportDialog()` / `openNewFileDialog()` without importing
// React or reaching into component state.

type OpenSetter = () => void;

let openExport: OpenSetter | null = null;
let openNewFile: OpenSetter | null = null;

export function registerDialogSetters(setters: {
  openExportDialog: OpenSetter;
  openNewFileDialog: OpenSetter;
}): () => void {
  openExport = setters.openExportDialog;
  openNewFile = setters.openNewFileDialog;
  return () => {
    openExport = null;
    openNewFile = null;
  };
}

export function openExportDialog(): void {
  openExport?.();
}

export function openNewFileDialog(): void {
  openNewFile?.();
}
