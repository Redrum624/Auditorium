import { useSyncExternalStore } from 'react';

/** Row->frequency mapping for the spectrogram (Task F4). See spectrogramCore.ts
 * for the exact formulas. */
export type SpectralScale = 'log' | 'linear';

// Module-level setting (explicitly NOT an appStore field, per the plan — this
// is a display preference, not session state). `SpectrogramView` subscribes via
// `useSpectralScale()`; `view.spectralScale` flips it via `toggleSpectralScale`.
let scale: SpectralScale = 'log';
let version = 0;
const listeners = new Set<() => void>();

function bumpVersion(): void {
  version++;
  for (const listener of listeners) listener();
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

function getSnapshot(): SpectralScale {
  return scale;
}

/** Non-reactive read for callers outside React (e.g. the postMessage payload
 * builder in SpectrogramView, or tests). */
export function getSpectralScale(): SpectralScale {
  return scale;
}

/** Flips 'log' <-> 'linear' and notifies subscribers. */
export function toggleSpectralScale(): void {
  scale = scale === 'log' ? 'linear' : 'log';
  bumpVersion();
}

/** Re-renders the caller whenever the spectral scale changes. */
export function useSpectralScale(): SpectralScale {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
