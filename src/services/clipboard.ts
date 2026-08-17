/** In-app audio clipboard: a single module-level slot holding the channel data
 * and source sample rate of the most recent cut/copy. It is deliberately
 * separate from the OS clipboard (which only carries text/images). */
export interface ClipboardData {
  channels: Float32Array[];
  sampleRate: number;
}

let clipboard: ClipboardData | null = null;

/** Stores a defensive copy of the channel data so later edits to the source
 * document cannot mutate what a subsequent paste will insert. */
export function setClipboard(data: ClipboardData): void {
  clipboard = {
    channels: data.channels.map((ch) => ch.slice()),
    sampleRate: data.sampleRate,
  };
}

/** Returns the stored clipboard (by reference — callers must not mutate it) or
 * null when nothing has been cut/copied yet. */
export function getClipboard(): ClipboardData | null {
  return clipboard;
}

/** Empties the clipboard. Primarily a test-isolation hook. */
export function clearClipboard(): void {
  clipboard = null;
}
