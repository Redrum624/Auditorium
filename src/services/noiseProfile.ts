/**
 * Noise print capture (Task 19). `captureNoiseProfile` reads the active document
 * and its selection from the store (falling back to the whole document when there
 * is no selection), and stores — per channel — the average STFT magnitude
 * spectrum (fftSize 2048, hop 512) across all frames of that region. The result
 * lives in a module-level slot consumed later by the Noise Reduction effect
 * (surfaced to the DSP worker as `extra.spectra`) and cleared explicitly.
 */

import { cloneRegion, docLength } from '../audio/AudioDocument';
import { stft } from '../dsp/stft';
import { useAppStore } from '../stores/appStore';

export interface NoiseProfile {
  docSampleRate: number;
  /** Average magnitude spectrum per channel, length fftSize/2+1. */
  spectra: Float32Array[];
}

const FFT_SIZE = 2048;
const HOP = 512;

let profile: NoiseProfile | null = null;

export function captureNoiseProfile(): void {
  const state = useAppStore.getState();
  const doc = state.documents.find((d) => d.id === state.activeDocumentId);
  if (!doc) return;

  const selection = state.selection;
  const start = selection ? selection.start : 0;
  const end = selection ? selection.end : docLength(doc);
  const region = cloneRegion(doc, start, end);

  const bins = FFT_SIZE / 2 + 1;
  const spectra = region.map((channel) => {
    const { frames } = stft(channel, FFT_SIZE, HOP);
    const avg = new Float32Array(bins);
    if (frames.length === 0) return avg;
    for (const frame of frames) {
      for (let k = 0; k < bins; k++) avg[k] += frame[k];
    }
    for (let k = 0; k < bins; k++) avg[k] /= frames.length;
    return avg;
  });

  profile = { docSampleRate: doc.sampleRate, spectra };
}

export function getNoiseProfile(): NoiseProfile | null {
  return profile;
}

export function clearNoiseProfile(): void {
  profile = null;
}
