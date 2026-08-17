/**
 * Task B2 — whether the beat tics are DRAWN. A display preference and nothing
 * else: it says nothing about whether a grid exists (that is `beatGrid.ts`'s
 * question) and it never causes an analysis to run.
 *
 * Module-level `useSyncExternalStore` state rather than an `appStore` field,
 * following `spectralScale.ts` exactly — this is a view preference, not session
 * state, so it must not be serialised into a session file, must not be part of
 * undo history, and must not re-render every store consumer when it flips.
 *
 * **Default: ON.** The user's request was *"when known, I want tics to be
 * printed"*, and a grid only exists after someone explicitly asked for an
 * analysis (Properties panel, `Pipeline -> Detect Tempo`, Auto-Remix), so
 * defaulting to visible cannot surprise anyone who has not asked for one:
 * with no cached analysis there is nothing to draw either way.
 */
import { useSyncExternalStore } from 'react';

let visible = true;
const listeners = new Set<() => void>();

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

function getSnapshot(): boolean {
  return visible;
}

/** Non-reactive read for callers outside React (menu `enabled`, test hooks). */
export function isBeatGridVisible(): boolean {
  return visible;
}

/** Sets the preference; notifies only when it actually changed. */
export function setBeatGridVisible(next: boolean): void {
  if (visible === next) return;
  visible = next;
  for (const listener of listeners) listener();
}

/** Flips the preference and returns the NEW value (what `view.beatGrid` and the
 * `toggleBeatGrid` test hook both need). */
export function toggleBeatGrid(): boolean {
  setBeatGridVisible(!visible);
  return visible;
}

/** Re-renders the caller whenever the beat-grid visibility changes. */
export function useBeatGridVisible(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
