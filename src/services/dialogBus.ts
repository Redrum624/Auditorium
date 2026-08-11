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
let openTempo: OpenSetter | null = null;
let openRemix: OpenSetter | null = null;
let openSeparate: OpenSetter | null = null;
let openTranscribe: OpenSetter | null = null;
let openVoiceChanger: OpenSetter | null = null;
let openAlignTiming: OpenSetter | null = null;
let focusRemix: OpenSetter | null = null;
let focusTranscript: OpenSetter | null = null;

export function registerDialogSetters(setters: {
  openExportDialog: OpenSetter;
  openNewFileDialog: OpenSetter;
  openEffectDialog: OpenEffectSetter;
  openConvertDialog: OpenConvertSetter;
  openRecordDialog: OpenSetter;
  openTempoDialog: OpenSetter;
  openRemixDialog: OpenSetter;
  openSeparateDialog: OpenSetter;
  openTranscribeDialog: OpenSetter;
  openVoiceChangerDialog: OpenSetter;
  /** F9's Align Vocal Timing dialog. */
  openAlignTimingDialog: OpenSetter;
  /** Not a dialog: switches the sidebar to the Remix tab once a remix
   * document exists (Task T14). It rides this bus for the same reason the
   * dialog openers do — the caller must not import React or reach into
   * App's component state. */
  focusRemixPanel: OpenSetter;
  /** Not a dialog either: switches the sidebar to the Transcript tab once a
   * transcript exists (F4b), for the same reason as `focusRemixPanel`. */
  focusTranscriptPanel: OpenSetter;
}): () => void {
  openExport = setters.openExportDialog;
  openNewFile = setters.openNewFileDialog;
  openEffect = setters.openEffectDialog;
  openConvert = setters.openConvertDialog;
  openRecord = setters.openRecordDialog;
  openTempo = setters.openTempoDialog;
  openRemix = setters.openRemixDialog;
  openSeparate = setters.openSeparateDialog;
  openTranscribe = setters.openTranscribeDialog;
  openVoiceChanger = setters.openVoiceChangerDialog;
  openAlignTiming = setters.openAlignTimingDialog;
  focusRemix = setters.focusRemixPanel;
  focusTranscript = setters.focusTranscriptPanel;
  return () => {
    openExport = null;
    openNewFile = null;
    openEffect = null;
    openConvert = null;
    openRecord = null;
    openTempo = null;
    openRemix = null;
    openSeparate = null;
    openTranscribe = null;
    openVoiceChanger = null;
    openAlignTiming = null;
    focusRemix = null;
    focusTranscript = null;
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

export function openTempoDialog(): void {
  openTempo?.();
}

export function openRemixDialog(): void {
  openRemix?.();
}

export function openSeparateDialog(): void {
  openSeparate?.();
}

export function openTranscribeDialog(): void {
  openTranscribe?.();
}

export function openVoiceChangerDialog(): void {
  openVoiceChanger?.();
}

export function openAlignTimingDialog(): void {
  openAlignTiming?.();
}

export function focusRemixPanel(): void {
  focusRemix?.();
}

export function focusTranscriptPanel(): void {
  focusTranscript?.();
}

// --- Open-dialog stack (Task M7: F10/F25) ---------------------------------
// DialogShell registers a token when it mounts and unregisters it on unmount,
// LIFO by mount order. shortcuts.ts calls `hasOpenDialog()` to bail out of
// every global shortcut while ANY dialog is open (F10): ExportDialog/
// EffectDialog/ConvertDialog resolve their target document from the LIVE
// activeDocumentId at confirm time, so a shortcut firing behind an open
// dialog (e.g. Ctrl+O while Export is open) would silently act on/replace the
// wrong document. DialogShell's own Escape handler calls `isTopDialog(token)`
// so with two dialogs stacked, one Escape press closes only the topmost
// (F25) — each DialogShell installs its own document keydown listener and
// stopPropagation cannot stop sibling listeners, so the ordering has to be an
// explicit stack check instead.
//
// Minting (`nextDialogToken`) and registering (`pushDialog`) are DELIBERATELY
// split (fix round 1): minting is a pure counter bump safe to call from a
// `useState` lazy initializer, which React (StrictMode, Suspense, an aborted
// concurrent render) may invoke more than once or discard entirely — it never
// touches the stack, so an extra/discarded call can't leak anything.
// Registering pushes onto the actual stack and must only ever happen from an
// effect, whose mount/cleanup are always paired 1:1 (including StrictMode's
// dev-only mount→cleanup→remount probe) — that pairing is what keeps the
// stack's push/pop count balanced no matter how many times render ran.

let dialogTokenCounter = 0;
const openDialogStack: number[] = [];

/** Mints a new unique dialog token WITHOUT touching the stack. Pure — safe to
 * call during render (e.g. a `useState` lazy initializer). */
export function nextDialogToken(): number {
  return ++dialogTokenCounter;
}

/** Registers `token` (from `nextDialogToken`) on top of the stack. Call ONLY
 * from a mount effect, paired with `popDialog(token)` in its cleanup. */
export function pushDialog(token: number): void {
  openDialogStack.push(token);
}

/** Unregisters a dialog (called from the same effect's cleanup). No-ops if
 * already removed. */
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
