// TEST-ONLY window hooks for the scripted headed smoke (scripts/e2e-smoke.cjs).
// Installed by App.tsx only when the preload flags test mode (--auditorium-test,
// set from AUDITORIUM_TEST=1). Never present in a normal run.

import { createDocument, docLength, type AudioDocument } from '../audio/AudioDocument';
import { RecordingEngine } from '../audio/RecordingEngine';
import { encodeWav } from '../audio/wavCodec';
import type { EffectParamValue } from '../effects/types';
import type { EditorView } from '../stores/appStore';
import { nextId, useAppStore } from '../stores/appStore';
import { createClip } from '../multitrack/session';
import { useSessionStore } from '../multitrack/sessionStore';
import { mixdownSession as renderMixdown } from '../multitrack/mixdown';
import { runEffectOnSelection } from './effectRunner';
import { captureNoiseProfile, getNoiseProfile } from './noiseProfile';
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
  getRms(): number;
  getChannelSamples(channel: number, start: number, count: number): number[];
  applyEffect(
    effectId: string,
    params: Record<string, EffectParamValue>,
    extra?: unknown
  ): Promise<number>;
  setView(view: EditorView): void;
  captureNoisePrint(): void;
  getNoiseProfileSpectra(): number[][] | null;
  recordSeconds(seconds: number): Promise<{ length: number; sampleRate: number; rms: number }>;
  newSession(sampleRate: number): void;
  insertActiveDocAsClip(
    trackIndex: number,
    startSample: number
  ): { clipId: string; lengthSample: number; startSample: number } | null;
  mixdownSession(): { name: string; length: number; sampleRate: number; rms: number } | null;
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

/** Root-mean-square across all channels of the active document. */
function activeRms(): number {
  const doc = activeDoc();
  if (!doc) return 0;
  let sum = 0;
  let count = 0;
  for (const ch of doc.channels) {
    for (let i = 0; i < ch.length; i++) sum += ch[i] * ch[i];
    count += ch.length;
  }
  return count > 0 ? Math.sqrt(sum / count) : 0;
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

    getRms: () => activeRms(),

    // Returns a slice of the active document's channel samples for the FLAC
    // round-trip smoke (compare the source tone against our encoder's output
    // after the packaged Chromium decodes it back).
    getChannelSamples: (channel, start, count) => {
      const doc = activeDoc();
      const ch = doc?.channels[channel];
      if (!ch) return [];
      const out: number[] = [];
      for (let i = 0; i < count && start + i < ch.length; i++) out.push(ch[start + i]);
      return out;
    },

    // Runs the effect end-to-end through the real DSP worker (no selection => whole
    // document). `extra` is forwarded to the worker's `__effectExtra` side channel
    // (Noise Reduction's captured profile). Returns the resulting peak.
    applyEffect: async (effectId, params, extra) => {
      await runEffectOnSelection(effectId, params, undefined, extra);
      return activePeak();
    },

    setView: (view) => useAppStore.getState().setView(view),

    captureNoisePrint: () => captureNoiseProfile(),

    getNoiseProfileSpectra: () => {
      const profile = getNoiseProfile();
      return profile ? profile.spectra.map((s) => Array.from(s)) : null;
    },

    // Drives a real RecordingEngine end-to-end (bypassing the dialog) for the
    // headed mic smoke: records `seconds` from the (fake-device) mic, creates a
    // 'Recording N' document, and reports its length + RMS so the harness can
    // assert a non-silent capture of roughly the expected duration.
    recordSeconds: async (seconds) => {
      const engine = new RecordingEngine();
      await engine.start({ channels: 1, sampleRate: 44100 });
      await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
      const { channels, sampleRate } = await engine.stop();
      const doc = createDocument({
        name: `Recording ${nextId('recording').split('-')[1]}`,
        sampleRate,
        channels,
      });
      useAppStore.getState().addDocument(doc);
      let sum = 0;
      let count = 0;
      for (const ch of channels) {
        for (let i = 0; i < ch.length; i++) sum += ch[i] * ch[i];
        count += ch.length;
      }
      const rms = count > 0 ? Math.sqrt(sum / count) : 0;
      return { length: channels[0]?.length ?? 0, sampleRate, rms };
    },

    // --- Multitrack (Task 22) ---------------------------------------------
    newSession: (sampleRate) => {
      useSessionStore.getState().newSession(sampleRate);
      useAppStore.getState().setView('multitrack');
    },

    // Inserts the active document as a clip on tracks[trackIndex] at startSample
    // (session samples), converting length when the doc rate differs.
    insertActiveDocAsClip: (trackIndex, startSample) => {
      const doc = activeDoc();
      if (!doc) return null;
      const store = useSessionStore.getState();
      const { session } = store;
      const track = session.tracks[trackIndex];
      if (!track) return null;
      const srcLen = docLength(doc);
      const lengthSample =
        doc.sampleRate === session.sampleRate
          ? srcLen
          : Math.round((srcLen * session.sampleRate) / doc.sampleRate);
      const clip = createClip({ documentId: doc.id, startSample, offsetSample: 0, lengthSample });
      store.addClip(track.id, clip);
      return { clipId: clip.id, lengthSample, startSample };
    },

    // Renders the session offline, adds the resulting stereo doc, switches to
    // the waveform view, and reports its length + RMS for assertion.
    mixdownSession: () => {
      const session = useSessionStore.getState().session;
      const map = new Map(useAppStore.getState().documents.map((d) => [d.id, d]));
      const { channels, sampleRate } = renderMixdown(session, map);
      if (channels[0].length === 0) return null;
      const n = nextId('mixdown').split('-')[1];
      const doc = createDocument({
        name: `Mixdown ${n}`,
        sampleRate,
        channels: [channels[0], channels[1]],
      });
      useAppStore.getState().addDocument(doc);
      useAppStore.getState().setView('waveform');
      let sum = 0;
      let count = 0;
      for (const ch of doc.channels) {
        for (let i = 0; i < ch.length; i++) sum += ch[i] * ch[i];
        count += ch.length;
      }
      const rms = count > 0 ? Math.sqrt(sum / count) : 0;
      return { name: doc.name, length: doc.channels[0].length, sampleRate, rms };
    },
  };

  (window as unknown as { __test: TestApi }).__test = testApi;
}
