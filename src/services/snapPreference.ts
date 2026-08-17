/**
 * Task B4 — whether the magnet is ON. A user preference and nothing else: it
 * says nothing about *what* the targets are (`editorSnapTargets` /
 * `sessionSnapTargets`) and nothing about the arithmetic (`snap.ts`).
 *
 * Module-level `useSyncExternalStore` state rather than an `appStore` field,
 * following `spectralScale.ts` and B2's `beatGridDisplay.ts` exactly — this is
 * a view/interaction preference, so it must not be serialised into a session
 * file, must not enter undo history, and must not re-render every store
 * consumer when it flips.
 *
 * **Deliberately independent of `beatGridDisplay`.** They answer different
 * questions ("are the tics drawn?" vs "do positions land on them?") and a user
 * can reasonably want either without the other: the tics are visual noise to
 * some, and the magnet is an obstacle to others. Coupling them would mean
 * turning off the ruler silently changed where a drag lands.
 *
 * **Default: ON.** The magnet is the thing the user asked for
 * (*"make the bar be able to magnet on those tics"*), it only ever engages when
 * targets exist — a cached beat grid or a marker somebody placed — and it has
 * two escape hatches when it does: hold the modifier (see `useEditorGestures`)
 * to suspend it for one gesture, or flip this preference to switch it off for
 * good.
 */
import { useSyncExternalStore } from 'react';

const DEFAULT_ENABLED = true;

let enabled = DEFAULT_ENABLED;
const listeners = new Set<() => void>();

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

function getSnapshot(): boolean {
  return enabled;
}

/** Non-reactive read for callers outside React — the gesture layer (which must
 * see the CURRENT value on every pointer event, not the one captured when the
 * component last rendered), the menu command's `enabled`, and the test hooks. */
export function isSnapEnabled(): boolean {
  return enabled;
}

/** Sets the preference; notifies only when it actually changed. */
export function setSnapEnabled(next: boolean): void {
  if (enabled === next) return;
  enabled = next;
  for (const listener of listeners) listener();
}

/** Flips the preference and returns the NEW value (what the toolbar magnet
 * button, the `view.snapToGrid` command and the `toggleSnap` test hook need). */
export function toggleSnap(): boolean {
  setSnapEnabled(!enabled);
  return enabled;
}

/** Re-renders the caller whenever the magnet is switched on or off. */
export function useSnapEnabled(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/** Test-only: the raw subscription, so the notify-on-change contract can be
 * asserted without rendering a component. */
export function _subscribeToSnapPreference(cb: () => void): () => void {
  return subscribe(cb);
}

/** Test-only: restores the shipped default between tests. */
export function _resetSnapPreference(): void {
  setSnapEnabled(DEFAULT_ENABLED);
}
