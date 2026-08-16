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
let openVocalChain: OpenSetter | null = null;
let openCoverChain: OpenSetter | null = null;
let openAlignLyrics: OpenSetter | null = null;
let focusRemix: OpenSetter | null = null;
let focusTranscript: OpenSetter | null = null;
let focusSpatial: OpenSetter | null = null;

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
  /** F7's Vocal Chain dialog. */
  openVocalChainDialog: OpenSetter;
  /** F10's Cover Chain dialog. */
  openCoverChainDialog: OpenSetter;
  /** F6's Align Lyrics dialog. */
  openAlignLyricsDialog: OpenSetter;
  /** Not a dialog: opens the Remix panel card once a remix document exists
   * (Task T14). It rides this bus for the same reason the dialog openers do —
   * the caller must not import React or reach into App's component state.
   * ("tab" until F11-8; the strip entry is contextual now, and this is what
   * opens the card whether or not the user has spotted the icon.) */
  focusRemixPanel: OpenSetter;
  /** Not a dialog either: opens the Transcript panel card once a transcript
   * exists (F4b), for the same reason as `focusRemixPanel`. Since F11-8 there
   * is no Transcript strip entry at all, so this is its only door. */
  focusTranscriptPanel: OpenSetter;
  /** F11-8. Not a dialog either — and unlike the two above it is not a
   * follow-up to a job that just finished, it is the positioner's ONLY door:
   * the user ruled Spatial a single tool rather than a module, so the module
   * strip carries no icon for it and `spatial.position` (Effects > Mix since
   * T8; Pipeline > Mix before it) calls this to put the panel in the card. */
  focusSpatialPanel: OpenSetter;
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
  openVocalChain = setters.openVocalChainDialog;
  openCoverChain = setters.openCoverChainDialog;
  openAlignLyrics = setters.openAlignLyricsDialog;
  focusRemix = setters.focusRemixPanel;
  focusTranscript = setters.focusTranscriptPanel;
  focusSpatial = setters.focusSpatialPanel;
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
    openVocalChain = null;
    openCoverChain = null;
    openAlignLyrics = null;
    focusRemix = null;
    focusTranscript = null;
    focusSpatial = null;
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

export function openVocalChainDialog(): void {
  openVocalChain?.();
}

export function openCoverChainDialog(): void {
  openCoverChain?.();
}

export function openAlignLyricsDialog(): void {
  openAlignLyrics?.();
}

export function focusRemixPanel(): void {
  focusRemix?.();
}

export function focusTranscriptPanel(): void {
  focusTranscript?.();
}

export function focusSpatialPanel(): void {
  focusSpatial?.();
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

// U2: a hosted pipeline tool (see components/Dialogs/DialogHost.tsx) does NOT
// join the stack above — the whole point of hosting is that the user keeps the
// stage while the tool is open, and joining would hand every global shortcut
// back to the bail-out below.
//
// While such a tool is RUNNING, though, the guard that stack exists for applies
// again word for word: these tools resolve their target document from the LIVE
// `activeDocumentId`, so a Ctrl+O behind a running Cover Chain would land the
// pass on a document the user replaced mid-flight. That is exactly the silent
// wrong-document write `hasOpenDialog` was introduced to stop (F10), and losing
// it was never part of what the user asked for.
//
// So the flag is separate from the stack, not on it: `isTopDialog` decides
// Escape ORDERING between stacked modals, and a card that installs no Escape
// handler must not be able to win that ordering from a modal opened over it.
// One boolean rather than a counter because App hosts at most one tool at a
// time — `PipelineToolHost.test` pins that the flag is cleared on unmount, which
// is the only way a stale `true` could strand the shortcuts.
let hostedToolRunning = false;

/** U2: records whether the hosted pipeline tool is mid-pass. Called by
 * `PipelineToolHost` from the module lock the dialog already publishes. */
export function setHostedToolRunning(running: boolean): void {
  hostedToolRunning = running;
}

/**
 * U2: drops the flag, for tests.
 *
 * Module state outlives a `render`/`unmount` pair, so a test that leaves a
 * hosted tool mid-pass (deliberately, or by failing an assertion before its
 * cleanup) hands the next test in the file a `hasOpenDialog()` that is true
 * with no dialog on the stack — which reads as an unrelated failure several
 * tests later. `_resetHostedToolRunning` is the seam that stops that being
 * detective work, matching the `_reset*` helpers elsewhere in the repo.
 */
export function _resetHostedToolRunning(): void {
  hostedToolRunning = false;
}

/** True while at least one dialog is open, or a hosted pipeline tool is
 * mid-pass (U2 — see above). */
export function hasOpenDialog(): boolean {
  return openDialogStack.length > 0 || hostedToolRunning;
}

/** True when `token` is the most-recently-opened (topmost) dialog. */
export function isTopDialog(token: number): boolean {
  return openDialogStack[openDialogStack.length - 1] === token;
}
