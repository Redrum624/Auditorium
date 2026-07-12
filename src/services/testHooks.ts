// TEST-ONLY window hooks for the scripted headed smoke (scripts/e2e-smoke.cjs).
// Installed by App.tsx only when the preload flags test mode (--auditorium-test,
// set from AUDITORIUM_TEST=1). Never present in a normal run.

import { docLength, type AudioDocument } from '../audio/AudioDocument';
import { encodeWav } from '../audio/wavCodec';
import type { EffectParamValue } from '../effects/types';
import { useAppStore } from '../stores/appStore';
import { runEffectOnSelection } from './effectRunner';
import { encodeExport, openFilePath, type ExportOptions } from './fileService';

export interface TestStateSummary {
  docCount: number;
  activeName: string | null;
  length: number;
  sampleRate: number | null;
  channels: number | null;
}

export interface TestApi {
  openPath(path: string): Promise<void>;
  getStateSummary(): TestStateSummary;
  exportActive(opts: ExportOptions, outPath: string): Promise<boolean>;
  saveActiveAs(outPath: string): Promise<boolean>;
  getPeak(): number;
  applyEffect(effectId: string, params: Record<string, EffectParamValue>): Promise<number>;
}

/** Largest absolute sample value across all channels of the active document. */
function activePeak(): number {
  const doc = activeDoc();
  if (!doc) return 0;
  let peak = 0;
  for (const ch of doc.channels) {
    for (let i = 0; i < ch.length; i++) {
      const a = Math.abs(ch[i]);
      if (a > peak) peak = a;
    }
  }
  return peak;
}

function activeDoc(): AudioDocument | null {
  const s = useAppStore.getState();
  return s.documents.find((d) => d.id === s.activeDocumentId) ?? null;
}

export function installTestHooks(): void {
  if (typeof window === 'undefined') return;

  const testApi: TestApi = {
    openPath: (path) => openFilePath(path),

    getStateSummary: () => {
      const s = useAppStore.getState();
      const doc = activeDoc();
      return {
        docCount: s.documents.length,
        activeName: doc?.name ?? null,
        length: doc ? docLength(doc) : 0,
        sampleRate: doc?.sampleRate ?? null,
        channels: doc?.channels.length ?? null,
      };
    },

    exportActive: async (opts, outPath) => {
      const doc = activeDoc();
      if (!doc) return false;
      const data = encodeExport(doc, opts);
      const result = await window.electronAPI.writeFile(outPath, data);
      return result.ok;
    },

    saveActiveAs: async (outPath) => {
      const doc = activeDoc();
      if (!doc) return false;
      const data = encodeWav(doc.channels, doc.sampleRate, 32);
      const result = await window.electronAPI.writeFile(outPath, data);
      if (result.ok) {
        useAppStore.getState().updateDocument({ ...doc, filePath: outPath, dirty: false });
      }
      return result.ok;
    },

    getPeak: () => activePeak(),

    // Runs the effect end-to-end through the real DSP worker (no selection => whole
    // document) and returns the resulting peak. Used by the headed smoke test.
    applyEffect: async (effectId, params) => {
      await runEffectOnSelection(effectId, params);
      return activePeak();
    },
  };

  (window as unknown as { __test: TestApi }).__test = testApi;
}
