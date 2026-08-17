/**
 * Noise print capture (Task 19). `captureNoiseProfile` reads the active document
 * and its selection from the store (falling back to the whole document when there
 * is no selection), and stores — per channel — the average STFT magnitude
 * spectrum (fftSize 2048, hop 512) across all frames of that region. The result
 * lives in a module-level slot consumed later by the Noise Reduction effect
 * (surfaced to the DSP worker as `extra.spectra`) and cleared explicitly.
 *
 * Task F8: the profile records the docId it was captured from so it can be
 * cleared when that document closes (see fileService.closeDocumentFlow), and a
 * version counter + `useNoiseProfileVersion()` (useSyncExternalStore) let React
 * consumers (EffectDialog's hasNoiseProfile) re-render on capture/clear.
 */

import { useSyncExternalStore } from 'react';
import { cloneRegion } from '../audio/AudioDocument';
import { stft } from '../dsp/stft';
import { useAppStore } from '../stores/appStore';
import { resolveRegion } from './selectionRegion';

export interface NoiseProfile {
  /** Id of the document the profile was captured from (Task F8). */
  docId: string;
  docSampleRate: number;
  /** Average magnitude spectrum per channel, length fftSize/2+1. */
  spectra: Float32Array[];
}

const FFT_SIZE = 2048;
const HOP = 512;

/**
 * The noise print itself: per channel, the average STFT magnitude spectrum over
 * every frame of the given audio (`fftSize/2+1` bins). Extracted from
 * `captureNoiseProfile` (F7) so the Vocal Chain can learn a print from the
 * quiet passage it measured without duplicating the transform — one definition
 * of "what a noise print is", used by both the manual capture and the chain.
 *
 * A channel with no complete frame (shorter than `fftSize`) yields an all-zero
 * spectrum, which Noise Reduction treats as "subtract nothing".
 */
export function averageMagnitudeSpectra(channels: Float32Array[]): Float32Array[] {
  const bins = FFT_SIZE / 2 + 1;
  return channels.map((channel) => {
    const { frames } = stft(channel, FFT_SIZE, HOP);
    const avg = new Float32Array(bins);
    if (frames.length === 0) return avg;
    for (const frame of frames) {
      for (let k = 0; k < bins; k++) avg[k] += frame[k];
    }
    for (let k = 0; k < bins; k++) avg[k] /= frames.length;
    return avg;
  });
}

let profile: NoiseProfile | null = null;
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

function getSnapshot(): number {
  return version;
}

export function captureNoiseProfile(): void {
  const state = useAppStore.getState();
  const doc = state.documents.find((d) => d.id === state.activeDocumentId);
  if (!doc) return;

  // T6-1: the last raw member of the clamp family. It was recorded as "same
  // shape, verified benign" because its only consumer is `cloneRegion`, which
  // clamps what it slices — so the spectra were always measured over the clamped
  // region and this reads identically. Benign is not the same as correct: a
  // second consumer added beside it would have inherited the raw pair, which is
  // exactly how the other members of this family were born.
  const { start, end } = resolveRegion(doc, state.selection);
  const region = cloneRegion(doc, start, end);

  const spectra = averageMagnitudeSpectra(region);

  profile = { docId: doc.id, docSampleRate: doc.sampleRate, spectra };
  bumpVersion();
}

export function getNoiseProfile(): NoiseProfile | null {
  return profile;
}

export function clearNoiseProfile(): void {
  if (profile === null) return; // nothing to clear — don't wake subscribers
  profile = null;
  bumpVersion();
}

/** Monotonic counter bumped on every capture/clear; non-reactive read. */
export function getNoiseProfileVersion(): number {
  return version;
}

/** Re-renders the caller whenever the noise profile is captured or cleared. */
export function useNoiseProfileVersion(): number {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
