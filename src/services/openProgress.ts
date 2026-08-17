/**
 * The files that are being read and decoded right now.
 *
 * Opening a large file is no longer instant from the UI's point of view — the
 * decode moved to a worker (`decodeWavOffThread`), so the app stays responsive
 * for the seconds it takes, and "responsive but showing nothing" is its own
 * kind of broken. During the incident the second document appeared in the list
 * and sat there blank; the user had no way to tell a working open from a hung
 * one. This is the state that lets the Files panel say which.
 *
 * Module-level `useSyncExternalStore` state rather than an `appStore` field,
 * following `beatGridDisplay.ts` / `spectralScale.ts`: an open in flight is
 * transient UI state, not session state, so it must not be serialised into a
 * session file, must not enter undo history, and must not re-render every
 * store consumer when it changes.
 */
import { useSyncExternalStore } from 'react';

export interface PendingOpen {
  /** Identifies this open across begin/end; ids are never reused. */
  token: number;
  /** Full path, for disambiguating two files with the same basename. */
  path: string;
  /** Basename, what the panel shows. */
  name: string;
}

let nextToken = 1;
let pending: readonly PendingOpen[] = [];
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

/** The snapshot is the array itself, replaced only when the set really
 * changes, so `useSyncExternalStore`'s identity check holds. */
function getSnapshot(): readonly PendingOpen[] {
  return pending;
}

/** Records that `path` is being opened. Returns the token to pass to
 * `endOpen`, whatever the outcome. */
export function beginOpen(path: string, name: string): number {
  const token = nextToken++;
  pending = [...pending, { token, path, name }];
  notify();
  return token;
}

/** Clears one open. Called from a `finally`, so it must be safe on a token
 * that is already gone (and must not notify when nothing changed). */
export function endOpen(token: number): void {
  const next = pending.filter((p) => p.token !== token);
  if (next.length === pending.length) return;
  pending = next;
  notify();
}

/** Non-reactive read for callers outside React (tests, test hooks). */
export function getPendingOpens(): readonly PendingOpen[] {
  return pending;
}

/** Test-only: drop every pending open. Nothing in the app clears the set
 * wholesale — each open ends its own. */
export function _resetPendingOpens(): void {
  if (pending.length === 0) return;
  pending = [];
  notify();
}

/** Re-renders the caller whenever a file starts or stops being opened. */
export function usePendingOpens(): readonly PendingOpen[] {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
