// TEST-ONLY window hooks for the scripted headed smoke (scripts/e2e-smoke.cjs).
// Installed by App.tsx only when the preload flags test mode (--auditorium-test,
// set from AUDITORIUM_TEST=1). Never present in a normal run.

import { createDocument, docLength, type AudioDocument } from '../audio/AudioDocument';
import { RecordingEngine } from '../audio/RecordingEngine';
import { encodeWav } from '../audio/wavCodec';
import { encodeOggOpus } from '../audio/oggOpusEncoder';
import type { EffectParamValue } from '../effects/types';
import type { EditorView, Marker } from '../stores/appStore';
import { nextId, useAppStore } from '../stores/appStore';
import {
  clampFadePair,
  createClip,
  crossfadableOverlap,
  DEFAULT_FADE_CURVE,
} from '../multitrack/session';
import { useSessionStore } from '../multitrack/sessionStore';
import { withSessionGesture } from '../multitrack/sessionUndo';
import type { AutomationLane, AutomationParam } from '../multitrack/automation';
import { mixdownSession as renderMixdown, resolveClipFadeSpecs } from '../multitrack/mixdown';
import { parseSessionFileBytes, serializeSessionV3 } from '../multitrack/sessionFile';
import { clearClipWaveformCache } from '../components/Multitrack/clipWaveformCache';
import { runEffectOnSelection } from './effectRunner';
import { captureNoiseProfile, getNoiseProfile } from './noiseProfile';
import { encodeExport, openFilePath, saveDocument, type ExportOptions } from './fileService';
import { convertSampleRate } from './documentTools';
import { copySelection, pasteAtCursor } from './editOps';
import { getClipboard } from './clipboard';
import { getSpectralScale, toggleSpectralScale, type SpectralScale } from './spectralScale';
import { getBeatGrid, isDownbeat } from './beatGrid';
import { isBeatGridVisible, toggleBeatGrid } from './beatGridDisplay';
import { editorSnapTargets } from '../components/Editor/editorSnapTargets';
import { SNAP_TOLERANCE_PX } from './snap';
import { isSnapEnabled, toggleSnap } from './snapPreference';
import { CONFIDENCE_LOW } from '../dsp/tempoCore';
import { markSavePoint } from './undoHistory';
import { runTempoAnalysis } from './tempoAnalysis';
import { applyTempoChange } from './tempoService';
import { createRemixDocument, getRemixSession } from './remixService';
import { getStemModelState as readStemModelState, separateStems as runStemSeparation } from './stemService';
import { landStems } from './stemLanding';
import { MultitrackPlayer, multitrackPlayer } from '../multitrack/MultitrackPlayer';
import { measureFirstPlayLatency as runFirstPlayLatency } from '../multitrack/firstPlayLatency';
import type { FirstPlayLatencyReport } from '../multitrack/firstPlayLatency';
import { multitrackRecorder } from '../multitrack/multitrackRecord';
import type { FadeCurve } from '../dsp/fades';

export interface TestStateSummary {
  docCount: number;
  activeName: string | null;
  length: number;
  sampleRate: number | null;
  channels: number | null;
  filePath: string | null;
  dirty: boolean | null;
  /** Task S4 provenance: true when the active document's audio has never been
   * written to a file (a recording, a Mix Down, `Remix N`, a stem). Gates the
   * close prompt and the quit guard's count alongside `dirty`. */
  neverSaved: boolean | null;
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
  // --- v1.1 flows -------------------------------------------------------------
  pasteResampleFlow(): {
    copiedLen: number;
    clipRate: number;
    destRate: number;
    beforeLen: number;
    afterLen: number;
    insertedLen: number;
  };
  getSpectralScale(): SpectralScale;
  toggleSpectralScale(): SpectralScale;
  multitrackLiveParamCheck(): Promise<{
    started: boolean;
    stillPlaying: boolean;
    advanced: boolean;
    pos1: number;
    pos2: number;
    volumeGain: number | null;
  }>;
  /** R4 (P2-7): measures cold/warm first-play latency of the multitrack path
   * on a FRESH player + FRESH real AudioContext (see firstPlayLatency.ts). */
  measureFirstPlayLatency(): Promise<FirstPlayLatencyReport>;
  punchInRecord(seconds: number): Promise<{
    docCreated: boolean;
    docName: string | null;
    clipStart: number | null;
    clipLength: number | null;
    cursor: number;
    armedTrackName: string | null;
  }>;
  // --- v1.2 flows -------------------------------------------------------------
  addMarkerToActive(positionSample: number, name: string): string | null;
  getActiveMarkers(): { name: string; positionSample: number }[];
  closeActive(): void;
  exportActiveOgg(outPath: string, bitrate?: number): Promise<boolean>;
  saveActiveInPlace(): Promise<{ ok: boolean; dirty: boolean | null; filePath: string | null }>;
  // --- v1.4 flows ---------------------------------------------------------
  saveSessionAs(outPath: string): Promise<boolean>;
  openSessionFrom(path: string): Promise<{
    docCount: number;
    trackCount: number;
    droppedClipCount: number;
  }>;
  // --- beat grid (Task B2) ------------------------------------------------
  /** Flips the beat-tic display preference; returns the NEW visibility. */
  toggleBeatGrid(): boolean;
  /** What would be drawn for the active document. Plain JSON scalars only —
   * the grid's `beatSamples` is an Int32Array and cannot cross page.evaluate. */
  getBeatGridState(): {
    visible: boolean;
    hasGrid: boolean;
    beatCount: number;
    firstBeatSample: number | null;
    lastBeatSample: number | null;
    downbeatCount: number;
    beatsPerBar: number | null;
    provisional: boolean;
    stale: boolean;
    confidence: number;
    analyzedEndSample: number;
    origin: 'own' | 'inherited' | null;
  };
  // --- snapping (Task B4) --------------------------------------------------
  /** Flips the snap ("magnet") preference; returns the NEW value. */
  toggleSnap(): boolean;
  /** The magnet's state and the target set a driven gesture would consult.
   * Plain JSON scalars only. There is deliberately no hook that PERFORMS a
   * snap — see the note at the implementation. */
  getSnapState(): {
    enabled: boolean;
    tolerancePx: number;
    targetCount: number;
    firstTargetSample: number | null;
    lastTargetSample: number | null;
  };
  /** Read-only OBSERVER of the editor's view state (Task B5). Performs no
   * gesture and no snap — it exists so a smoke step that drove REAL pointer
   * events can (a) work out where on the canvas a given sample is, and
   * (b) read back the resulting cursor sample-exactly instead of through the
   * status pill's millisecond-rounded text. */
  getEditorViewState(): {
    cursorSample: number;
    selectionStart: number | null;
    selectionEnd: number | null;
    samplesPerPixel: number;
    scrollSample: number;
  };
  // --- v1.5 flows ---------------------------------------------------------
  detectTempo(): Promise<{
    bpm: number | null;
    confidence: number;
    beatCount: number;
    firstBeatSample: number | null;
    stale: boolean;
  }>;
  changeTempo(sourceBpm: number, targetBpm: number): Promise<{ ok: boolean; length: number }>;
  remixToDuration(
    seconds: number,
    opts?: { phraseBars?: number; strict?: boolean }
  ): Promise<{
    ok: boolean;
    status: string;
    name: string | null;
    length: number;
    sampleRate: number;
    joins: number;
    achievedSeconds: number;
    targetSeconds: number;
    bpm: number;
    bars: number;
  }>;
  getRemixJoins(): { fromBar: number; toBar: number; atSample: number; cost: number }[] | null;
  // --- v1.7 flows ---------------------------------------------------------
  getStemModelState(): Promise<{ downloaded: boolean; bytes: number | null; expectedBytes: number }>;
  separateStems(): Promise<StemSeparationSummary>;
  // --- v1.9 flows (X7) ----------------------------------------------------
  //
  // Scalars only, per the getBeatGridState precedent: no live Clip objects, no
  // store handles. Everything below calls the REAL store action / resolver /
  // player — none of it re-implements a clamp or a rule.
  /** Sets one edge's fade through the store's own `setClipFade` (THE clamp
   * boundary) and echoes what the store kept. `curve` is runtime-checked by
   * the store against FADE_CURVES; an unknown string is ignored, exactly as
   * for any other JS caller. Returns null for an unknown clip id. */
  setClipFade(
    clipId: string,
    edge: 'in' | 'out',
    fade: { lengthSample?: number; curve?: string }
  ): ClipFadeSummary | null;
  /** Every clip's stored fade state plus the renderer's own resolved
   * crossfade widths — enough to distinguish "fade keys present" from
   * "crossfade actually armed" (rule 3 is the resolver's, not re-derived). */
  getClipFadeState(): { selectedClipId: string | null; clips: ClipFadeSummary[] };
  /** Arms the crossfade-capable pair on one edge of the clip — the panel's
   * Arm path: the pair from `crossfadableOverlap`, enablement from the
   * store's own exported `clampFadePair` (refusing partial arms), then both
   * facing fades written through `setClipFade`. */
  armCrossfade(
    clipId: string,
    edge: 'in' | 'out'
  ): { ok: boolean; reason: string | null; width: number; outClipId: string | null; inClipId: string | null };
  /** Clears BOTH facing fades of the pair on one edge — the panel's Release
   * path (clearing one side would strand a surprise solo fade). */
  releaseCrossfade(
    clipId: string,
    edge: 'in' | 'out'
  ): { ok: boolean; reason: string | null; outClipId: string | null; inClipId: string | null };
  /** Renders the CURRENT session through the real MultitrackPlayer graph in
   * an OfflineAudioContext — the genuine Web Audio engine performs the
   * summation — and compares it per sample against `mixdownSession`. This is
   * the end-to-end half of ruling 4 that the unit parity test cannot reach
   * (Jest has no OfflineAudioContext; its "player path" sums in test
   * arithmetic). `overlap` scopes the inside/outside error split; `probes`
   * returns raw rendered values at the given absolute sample indices so the
   * harness can assert law anchors with its own independent arithmetic. */
  renderSessionWebAudio(
    overlap: { start: number; end: number } | null,
    probeIndices: number[]
  ): Promise<WebAudioRenderSummary>;
  // --- v1.10 flows (F0) ----------------------------------------------------
  /** Every track's stored automation lanes as plain JSON — `null` when the
   * track has no `automation` field at all (absent means none, trap T9: the
   * smoke asserts the FIELD's absence, not just emptiness, after the last
   * key is deleted through the real gesture). */
  getAutomationState(): { tracks: { trackId: string; automation: AutomationLane[] | null }[] };
  /** Writes one automation key through the store's own `upsertAutomationKey`
   * (THE write boundary — position rounding, value clamping and curve
   * validation are the store's, exactly as for any other JS caller) and
   * echoes the track's stored lanes. Returns null for an out-of-range track
   * index. */
  upsertAutomationKey(
    trackIndex: number,
    param: AutomationParam,
    key: { positionSample: number; value: number; curve?: string },
    replacePositionSample?: number
  ): { automation: AutomationLane[] | null } | null;
}

/** Plain-JSON snapshot of one clip's fade state (v1.9 X7). Stored values are
 * read under the consumer contract (`?? 0` / `?? DEFAULT_FADE_CURVE`);
 * `crossInWidth`/`crossOutWidth` are `resolveClipFadeSpecs`' own verdict. */
export interface ClipFadeSummary {
  clipId: string;
  trackIndex: number;
  startSample: number;
  lengthSample: number;
  fadeInSample: number;
  fadeOutSample: number;
  fadeInCurve: string;
  fadeOutCurve: string;
  crossInWidth: number | null;
  crossOutWidth: number | null;
}

/** Plain-JSON result of `renderSessionWebAudio` (v1.9 X7). All errors are
 * absolute |web − mixdown| over both channels; "inside"/"outside" refer to
 * the caller-supplied overlap region (with no region, everything counts as
 * outside). Probe values are raw float32 samples from both paths. */
export interface WebAudioRenderSummary {
  ok: boolean;
  reason: string | null;
  lengthSamples: number;
  sampleRate: number;
  worstAbsError: number;
  worstAbsErrorInside: number;
  worstAbsErrorOutside: number;
  exactFraction: number;
  exactFractionOutside: number;
  webPeak: number;
  mixPeak: number;
  probes: { index: number; webL: number; webR: number; mixL: number; mixR: number }[];
}

/** Plain-JSON result of the `separateStems` hook (see its implementation). */
export interface StemSeparationSummary {
  ok: boolean;
  /** `'ok'` on success, otherwise the service's own `StemSeparationStatus`. */
  status: string;
  /** The service's user-facing failure message; null on success. */
  message: string | null;
  /** The five stem document names, in track order (Residual last). */
  documentNames: string[];
  sessionName: string | null;
  lengthSamples: number;
  sampleRate: number;
  /** Channel count of the SOURCE document (a mono source lands as dual-mono). */
  channelCount: number;
  sanitisedEstimateSamples: number;
  monoRoutedAsDualMono: boolean;
  sourcePeak: number | null;
  exactSumHolds: boolean | null;
  /** Worst |mixdown − source| over the whole landed session; null if unmeasurable. */
  mixdownWorstAbsError: number | null;
  /** Fraction of compared samples that are bit-identical (1 = sample-identical). */
  mixdownExactFraction: number | null;
  /** Peak |sample| of the mixdown, for the no-clipping-beyond-the-source check. */
  mixdownPeak: number | null;
  elapsedMs: number;
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

/** Every clip's fade snapshot (v1.9 X7) — see {@link ClipFadeSummary}. */
function fadeSummaries(): ClipFadeSummary[] {
  const { session } = useSessionStore.getState();
  const out: ClipFadeSummary[] = [];
  session.tracks.forEach((t, trackIndex) => {
    const specs = resolveClipFadeSpecs(t.clips);
    for (const c of t.clips) {
      const spec = specs.get(c.id);
      out.push({
        clipId: c.id,
        trackIndex,
        startSample: c.startSample,
        lengthSample: c.lengthSample,
        fadeInSample: c.fadeInSample ?? 0,
        fadeOutSample: c.fadeOutSample ?? 0,
        fadeInCurve: c.fadeInCurve ?? DEFAULT_FADE_CURVE,
        fadeOutCurve: c.fadeOutCurve ?? DEFAULT_FADE_CURVE,
        crossInWidth: spec?.crossIn?.lengthSample ?? null,
        crossOutWidth: spec?.crossOut?.lengthSample ?? null,
      });
    }
  });
  return out;
}

/** The crossfade-capable pair on one edge of a clip — the PropertiesPanel's
 * own `pairOnEdge` logic verbatim (full-track geometry, rule 4 included), so
 * the hook and the panel cannot disagree about which pair Arm/Release touch.
 * Rule 4 guarantees at most one capable pair per edge. */
function pairOnEdge(
  clipId: string,
  edge: 'in' | 'out'
): { a: { id: string; fadeInSample?: number; lengthSample: number }; b: { id: string; fadeOutSample?: number; lengthSample: number }; width: number } | null {
  const { session } = useSessionStore.getState();
  for (const t of session.tracks) {
    const clip = t.clips.find((c) => c.id === clipId);
    if (!clip) continue;
    for (const m of t.clips) {
      if (m.id === clip.id) continue;
      const geo = crossfadableOverlap(t.clips, clip, m);
      if (!geo) continue;
      if (edge === 'in' ? geo.b.id === clip.id : geo.a.id === clip.id) return geo;
    }
    return null;
  }
  return null;
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
        filePath: doc?.filePath ?? null,
        dirty: doc?.dirty ?? null,
        neverSaved: doc?.neverSaved ?? null,
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
      const data = encodeWav(
        doc.channels,
        doc.sampleRate,
        32,
        useAppStore.getState().markers[doc.id]
      );
      const result = await window.electronAPI.writeFile(outPath, data);
      if (result.ok) {
        useAppStore.getState().updateDocument({ ...doc, filePath: outPath, dirty: false });
        markSavePoint(doc.id);
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
      await runEffectOnSelection(effectId, params, { extra });
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

    // --- v1.1 flows -------------------------------------------------------

    // Paste with automatic sample-rate conversion (Task F1). Duplicates the
    // active (full-rate) document, halves the copy to 22050 Hz via the real
    // convertSampleRate transform, copies a fixed region from it, then pastes
    // into the original 44100 Hz document — pasteAtCursor resamples the 22050 Hz
    // clipboard up to the doc rate, so the inserted length is ~2x what was
    // copied. Returns the lengths/rates so the harness can assert the doubling.
    pasteResampleFlow: () => {
      const dest = activeDoc();
      if (!dest) throw new Error('pasteResampleFlow: no active document');
      const destRate = dest.sampleRate;
      const destId = dest.id;
      // Duplicate the active tone as a new document, then halve its rate.
      const copy = createDocument({
        name: 'Resample Source',
        sampleRate: destRate,
        channels: dest.channels.map((c) => c.slice()),
      });
      useAppStore.getState().addDocument(copy); // becomes active
      convertSampleRate(copy.id, Math.round(destRate / 2)); // -> 22050 Hz
      // Copy a fixed region from the (now half-rate) document.
      useAppStore.getState().setSelection({ start: 0, end: 10000 });
      copySelection();
      const clip = getClipboard();
      const copiedLen = clip?.channels[0]?.length ?? 0;
      const clipRate = clip?.sampleRate ?? 0;
      // Paste into the original full-rate document at its start.
      useAppStore.getState().setActiveDocument(destId);
      const before = activeDoc();
      const beforeLen = before ? docLength(before) : 0;
      useAppStore.getState().setSelection(null);
      useAppStore.getState().setCursor(0);
      pasteAtCursor();
      const after = activeDoc();
      const afterLen = after ? docLength(after) : 0;
      return { copiedLen, clipRate, destRate, beforeLen, afterLen, insertedLen: afterLen - beforeLen };
    },

    getSpectralScale: () => getSpectralScale(),

    toggleSpectralScale: () => {
      toggleSpectralScale();
      return getSpectralScale();
    },

    // Live multitrack parameters (Task F5): play the current session, change a
    // track's volume via the session store, and retro-apply it to the RUNNING
    // graph (as the MultitrackView subscription does) — no source rebuild. The
    // harness asserts the playhead keeps advancing and the volume gain ramped.
    multitrackLiveParamCheck: async () => {
      const store = useSessionStore.getState();
      const session = store.session;
      const docs = new Map(useAppStore.getState().documents.map((d) => [d.id, d]));
      multitrackPlayer.play(0, session, docs);
      const started = multitrackPlayer.state === 'playing';
      const pos1 = multitrackPlayer.getPositionSample();
      const track0 = session.tracks[0];
      if (track0) {
        store.setTrackParam(track0.id, { volumeDb: -12 });
        multitrackPlayer.applyTrackParams(useSessionStore.getState().session.tracks);
      }
      // v1.5.2 (smoke 6b flake): a single fixed 400 ms wait sometimes sampled
      // pos2 before the player's AudioContext had actually STARTED on a cold
      // first run ({advanced:false, pos1:0, pos2:0}), passing only on re-run.
      // Poll (50 ms steps, up to 3 s) until the transport has demonstrably
      // advanced past pos1, then settle a further 150 ms (10x the player's
      // 15 ms PARAM_SMOOTH ramp time constant) before taking the pos2 /
      // volumeGain samples the harness asserts on. Nothing asserted got
      // weaker: pos2 > pos1 still requires genuine advancement while playing
      // with the live change applied, and volumeGain is now ALWAYS read well
      // past the ramp (the old fixed wait could catch it mid-ramp when the
      // context started late).
      const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
      const deadline = Date.now() + 3000;
      while (multitrackPlayer.getPositionSample() <= pos1 && Date.now() < deadline) {
        await sleep(50);
      }
      await sleep(150);
      const pos2 = multitrackPlayer.getPositionSample();
      const stillPlaying = multitrackPlayer.state === 'playing';
      const volumeGain =
        track0 ? multitrackPlayer.liveTrackNodes(track0.id)?.volumeGain.gain.value ?? null : null;
      multitrackPlayer.stop();
      return { started, stillPlaying, advanced: pos2 > pos1, pos1, pos2, volumeGain };
    },

    // R4 (P2-7): the first-play latency instrument. Runs on a FRESH
    // MultitrackPlayer with a FRESH real AudioContext — the singleton player
    // is deliberately untouched, because its context may already be warm
    // from earlier steps, which is exactly what a FIRST-play measurement
    // must avoid. Plays the CURRENT session (cold probe, then a warm probe
    // on the same context) and returns the timing report; the player and
    // its context are disposed before returning.
    measureFirstPlayLatency: async () => {
      const session = useSessionStore.getState().session;
      const docs = new Map(useAppStore.getState().documents.map((d) => [d.id, d]));
      return runFirstPlayLatency(session, docs, () => new AudioContext());
    },

    // Multitrack punch-in recording (Task F6): arm the first track, set the
    // punch-in cursor, then run the real multitrackRecorder against the fake mic
    // (launch flags). On stop it creates a 'Track Recording N' document and drops
    // a clip onto the armed track at the cursor; the harness asserts both exist.
    punchInRecord: async (seconds) => {
      const store = useSessionStore.getState();
      const track0 = store.session.tracks[0];
      if (!track0) throw new Error('punchInRecord: no track to arm');
      store.setTrackParam(track0.id, { armed: true });
      const cursor = 22050;
      store.setMtCursor(cursor);
      await multitrackRecorder.start();
      await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
      await multitrackRecorder.stop();
      const docs = useAppStore.getState().documents;
      const recDoc = docs.find((d) => /^Track Recording /.test(d.name)) ?? null;
      const armedTrack = useSessionStore
        .getState()
        .session.tracks.find((t) => t.id === track0.id);
      const clip = recDoc
        ? armedTrack?.clips.find((c) => c.documentId === recDoc.id)
        : undefined;
      return {
        docCreated: recDoc !== null,
        docName: recDoc?.name ?? null,
        clipStart: clip?.startSample ?? null,
        clipLength: clip?.lengthSample ?? null,
        cursor,
        armedTrackName: armedTrack?.name ?? null,
      };
    },

    // --- v1.2 flows ---------------------------------------------------------

    // Adds a marker to the active document via the real store action (Task G1),
    // minting a fresh id the same way the app does. Returns the new marker's id,
    // or null if there is no active document.
    addMarkerToActive: (positionSample, name) => {
      const doc = activeDoc();
      if (!doc) return null;
      const marker: Marker = { id: nextId('marker'), name, positionSample };
      useAppStore.getState().addMarker(doc.id, marker);
      return marker.id;
    },

    // Reads back the active document's markers (sorted by position, per the
    // store contract) for the round-trip smoke's assertions.
    getActiveMarkers: () => {
      const doc = activeDoc();
      if (!doc) return [];
      const list = useAppStore.getState().markers[doc.id] ?? [];
      return list.map((m) => ({ name: m.name, positionSample: m.positionSample }));
    },

    // Closes the active document via the plain store action (no save-prompt
    // dialog, which would block headless) so the markers smoke can prove a
    // reopened file's markers came from disk, not leftover store state.
    closeActive: () => {
      const doc = activeDoc();
      if (!doc) return;
      useAppStore.getState().closeDocument(doc.id);
    },

    // Encodes the active document to Ogg Opus via the real async encoder
    // (WebCodecs AudioEncoder + the pure-TS Ogg muxer, Task G2) and writes it
    // directly — bypassing exportDocument's native save dialog, which cannot be
    // driven headlessly, the same way exportActive bypasses it for the
    // synchronous formats. Carries the active doc's markers the same way
    // exportDocument/encodeInPlace do in production (Task K5/K6), so the OGG
    // marker round-trip smoke can export through this hook.
    exportActiveOgg: async (outPath, bitrate) => {
      const doc = activeDoc();
      if (!doc) return false;
      const bytes = await encodeOggOpus(
        doc.channels,
        doc.sampleRate,
        bitrate,
        useAppStore.getState().markers[doc.id]
      );
      const buf = new ArrayBuffer(bytes.byteLength);
      new Uint8Array(buf).set(bytes);
      const result = await window.electronAPI.writeFile(outPath, buf);
      return result.ok;
    },

    // Drives the REAL production saveDocument() for an in-place Save. Safe to
    // call directly here (unlike exportDocument): when the document already has
    // a filePath, saveDocument re-encodes and writes without prompting any
    // dialog on success (only on failure, which a test-output-dir write should
    // never hit).
    saveActiveInPlace: async () => {
      const doc = activeDoc();
      if (!doc) return { ok: false, dirty: null, filePath: null };
      try {
        await saveDocument(doc.id);
      } catch {
        return { ok: false, dirty: doc.dirty, filePath: doc.filePath };
      }
      const after = activeDoc();
      return { ok: true, dirty: after?.dirty ?? null, filePath: after?.filePath ?? null };
    },

    // --- v1.4 flows -----------------------------------------------------

    // Serializes the current session to .audm v3 (Task M5/F3) and writes it
    // directly, bypassing saveSessionViaDialog's native showSaveDialog +
    // success showMessageBox (neither of which can be driven headlessly).
    // Mirrors production's serializeSessionV3 call exactly (same session,
    // docs, and markers sources) so the smoke proves the real writer.
    saveSessionAs: async (outPath) => {
      const session = useSessionStore.getState().session;
      const docs = useAppStore.getState().documents;
      const markers = useAppStore.getState().markers;
      let bytes: Uint8Array<ArrayBuffer>;
      try {
        ({ bytes } = serializeSessionV3(session, docs, markers));
      } catch {
        return false;
      }
      const result = await window.electronAPI.writeFile(outPath, bytes.buffer);
      return result.ok;
    },

    // Reads and parses a .audm file via the real dispatcher (parseSessionFileBytes,
    // which sniffs the v3 AUDM3 magic vs. legacy JSON) and applies it to the
    // store the same way openSessionViaDialog does, bypassing its native
    // showOpenDialog + info showMessageBox. Returns a small summary so the
    // smoke harness can assert the round trip without a separate "list all
    // docs" hook — the reopened document(s) are also addDocument'd, so the
    // last one is active and getStateSummary()/getActiveMarkers() read it back.
    openSessionFrom: async (path) => {
      const buf = await window.electronAPI.readFile(path);
      const result = parseSessionFileBytes(buf);
      for (const doc of result.documents) {
        useAppStore.getState().addDocument(doc);
      }
      for (const [docId, markerList] of Object.entries(result.markers)) {
        useAppStore.getState().setMarkersForDoc(docId, markerList);
      }
      useSessionStore.setState({
        session: result.session,
        selectedClipId: null,
        mtCursorSample: 0,
        mtZoom: { samplesPerPixel: 512, scrollSample: 0 },
        mtPlayState: 'stopped',
        mtPlayheadSample: 0,
      });
      clearClipWaveformCache();
      useAppStore.getState().setView('multitrack');
      return {
        docCount: result.documents.length,
        trackCount: result.session.tracks.length,
        droppedClipCount: result.droppedClipCount,
      };
    },

    // --- v1.5 flows -------------------------------------------------------
    //
    // Every hook below calls its SERVICE directly, bypassing the menu command
    // and the dialog (neither of which can be driven headlessly), exactly like
    // exportActiveOgg / saveSessionAs above. Each returns PLAIN JSON — typed
    // arrays are read out as scalars or copied with Array.from (the
    // getNoiseProfileSpectra convention), because anything crossing
    // page.evaluate's structured-clone boundary as a typed array arrives on
    // the harness side as an object keyed by index.
    //
    // Beat-grid display (Task B2 — the T6 overlay the v1.5 plan cut, now
    // built): `toggleBeatGrid` flips the module-level visibility preference and
    // returns the NEW value, exactly as the T16 spec defined it, and
    // `getBeatGridState` reports what would be drawn. Neither ever starts an
    // analysis (`getBeatGrid` is a cached read by construction), so the smoke
    // can only observe tics after it has run `detectTempo` itself.
    toggleBeatGrid: () => toggleBeatGrid(),

    // Scalars only. `beatSamples` is an Int32Array and cannot cross
    // page.evaluate's structured-clone boundary as itself (it arrives on the
    // harness side as an object keyed by index), so the positions are reported
    // as a count plus the first/last values — the same convention detectTempo
    // and getNoiseProfileSpectra follow.
    getBeatGridState: () => {
      const doc = activeDoc();
      const grid = doc ? getBeatGrid(doc.id) : null;
      if (!grid) {
        return {
          visible: isBeatGridVisible(),
          hasGrid: false,
          beatCount: 0,
          firstBeatSample: null,
          lastBeatSample: null,
          downbeatCount: 0,
          beatsPerBar: null,
          provisional: false,
          stale: false,
          confidence: 0,
          analyzedEndSample: 0,
          origin: null,
        };
      }
      let downbeatCount = 0;
      for (let i = 0; i < grid.beatSamples.length; i++) {
        if (isDownbeat(grid, i)) downbeatCount++;
      }
      return {
        visible: isBeatGridVisible(),
        hasGrid: true,
        beatCount: grid.beatSamples.length,
        firstBeatSample: grid.beatSamples[0],
        lastBeatSample: grid.beatSamples[grid.beatSamples.length - 1],
        downbeatCount,
        beatsPerBar: grid.beatsPerBar,
        provisional: grid.stale || grid.confidence < CONFIDENCE_LOW,
        stale: grid.stale,
        confidence: grid.confidence,
        analyzedEndSample: grid.analyzedEndSample,
        origin: grid.origin,
      };
    },

    // Snapping (Task B4). Deliberately a PREFERENCE hook and nothing more:
    // there is intentionally no `snapCursorTo(x)` hook, because a hook that
    // computed a snapped position would bypass the gesture layer entirely and
    // let a smoke assertion pass without the magnet ever having run. Anything
    // asserting the magnet must drive real pointer events; these two exist only
    // so a harness can put the preference into a known state first and read
    // back what a driven gesture should have used.
    toggleSnap: () => toggleSnap(),

    getSnapState: () => {
      const doc = activeDoc();
      const targets = editorSnapTargets(doc ? doc.id : null);
      return {
        enabled: isSnapEnabled(),
        tolerancePx: SNAP_TOLERANCE_PX,
        // Scalars only — the same convention getBeatGridState follows, since a
        // typed array cannot cross page.evaluate's structured-clone boundary.
        targetCount: targets.length,
        firstTargetSample: targets.length > 0 ? targets[0] : null,
        lastTargetSample: targets.length > 0 ? targets[targets.length - 1] : null,
      };
    },

    // A pure OBSERVER of the view state the gesture layer works in (B5), and
    // deliberately nothing more: it never sets the cursor, never computes a
    // snap and never touches the target set — so it cannot stand in for the
    // magnet the way a `snapCursorTo(x)` hook would (trap 28). It exists
    // because a smoke step driving REAL pointer events needs two things the
    // renderer otherwise keeps to itself: the pixel↔sample mapping
    // (`scrollSample` / `samplesPerPixel`, so it can aim at a known beat) and
    // the resulting cursor position as an exact sample — the status pill only
    // renders it rounded to the millisecond, which is 44 samples wide at
    // 44.1 kHz and cannot express "landed exactly on the beat".
    getEditorViewState: () => {
      const s = useAppStore.getState();
      return {
        cursorSample: s.cursorSample,
        selectionStart: s.selection ? s.selection.start : null,
        selectionEnd: s.selection ? s.selection.end : null,
        samplesPerPixel: s.zoom.samplesPerPixel,
        scrollSample: s.zoom.scrollSample,
      };
    },

    // Runs the REAL shared analysis (worker + cache, T4) over the whole active
    // document — the same call `tempo.detect` makes — and flattens the entry
    // to scalars. `beatSamples` is an Int32Array, so only its length and first
    // element cross the boundary, never the array itself.
    detectTempo: async () => {
      const doc = activeDoc();
      const entry = doc ? await runTempoAnalysis(doc) : null;
      if (!entry) {
        return { bpm: null, confidence: 0, beatCount: 0, firstBeatSample: null, stale: false };
      }
      return {
        bpm: entry.bpm,
        confidence: entry.confidence,
        beatCount: entry.beatSamples.length,
        firstBeatSample: entry.beatSamples.length > 0 ? entry.beatSamples[0] : null,
        stale: entry.stale,
      };
    },

    // Drives the real applyTempoChange (ratio -> the shared 'time-stretch'
    // effect through runEffectOnSelection), bypassing the Match Tempo dialog.
    // No selection is set, so the whole document is the region and the new
    // length must be exactly `round(oldLength * sourceBpm / targetBpm)`.
    changeTempo: async (sourceBpm, targetBpm) => {
      const outcome = await applyTempoChange({ sourceBpm, targetBpm });
      const after = activeDoc();
      return { ok: outcome.ok, length: after ? docLength(after) : 0 };
    },

    // Drives the real createRemixDocument (analyse -> plan -> render -> new
    // 'Remix N' document) for the active document, bypassing the Auto-Remix
    // dialog. `seconds` is converted to the source document's sample clock,
    // which is what RemixOptions.targetSample is measured in.
    remixToDuration: async (seconds, opts) => {
      const source = activeDoc();
      const empty = {
        ok: false,
        status: 'no-document',
        name: null,
        length: 0,
        sampleRate: 0,
        joins: 0,
        achievedSeconds: 0,
        targetSeconds: seconds,
        bpm: 0,
        bars: 0,
      };
      if (!source) return empty;

      const result = await createRemixDocument({
        sourceDocId: source.id,
        targetSample: Math.round(seconds * source.sampleRate),
        phraseBars: opts?.phraseBars,
        strict: opts?.strict,
      });
      if (!result.ok) return { ...empty, status: result.status, targetSeconds: seconds };

      const session = getRemixSession(result.remixDocId);
      const remixDoc =
        useAppStore.getState().documents.find((d) => d.id === result.remixDocId) ?? null;
      const length = remixDoc ? docLength(remixDoc) : 0;
      const sampleRate = remixDoc?.sampleRate ?? 0;
      return {
        ok: true,
        status: 'ok',
        name: remixDoc?.name ?? null,
        length,
        sampleRate,
        joins: result.plan.joins.length,
        achievedSeconds: sampleRate > 0 ? length / sampleRate : 0,
        targetSeconds: seconds,
        bpm: session?.analysis.bpm ?? 0,
        bars: session?.analysis.numBars ?? 0,
      };
    },

    // The active document's remix joins, flattened for assertion: the plan's
    // bar pair, the OUTPUT-sample position of the join's crossfade centre
    // (`joinSamples`, parallel to `plan.joins`), and the scalar total of the
    // six-term cost breakdown. Null when the active document is not a remix.
    getRemixJoins: () => {
      const doc = activeDoc();
      const session = doc ? getRemixSession(doc.id) : null;
      if (!session) return null;
      return session.plan.joins.map((join, i) => ({
        fromBar: join.fromBar,
        toBar: join.toBar,
        atSample: session.joinSamples[i] ?? 0,
        cost: join.cost.total,
      }));
    },

    // --- v1.7 flows -------------------------------------------------------

    // Whether the 166 MB separation model is already on disk. The smoke's stem
    // step is gated on this: the model is downloaded on first use and is NOT in
    // the repo, so a machine without it must REPORT a skip, never pass quietly.
    getStemModelState: () => readStemModelState(),

    // Separates the ACTIVE document into stems and lands them, bypassing
    // SeparateDialog entirely — the same two calls the dialog makes
    // (`separateStems` then `landStems`), so the smoke exercises the service and
    // the landing, not the React state machine.
    //
    // The measured mixdown identity is computed HERE rather than asserted in the
    // harness because it needs the raw float samples on both sides: the landed
    // session is mixed down for real (`mixdownSession`, the same renderer Mix
    // Down uses) and compared sample-for-sample against the source document. A
    // mono source is compared against BOTH master sides, so a routing that fixed
    // only one side cannot pass. Everything returned is plain JSON — typed
    // arrays do not survive Playwright's `page.evaluate` bridge.
    separateStems: async () => {
      const empty: StemSeparationSummary = {
        ok: false,
        status: 'no-document',
        message: null,
        documentNames: [],
        sessionName: null,
        lengthSamples: 0,
        sampleRate: 0,
        channelCount: 0,
        sanitisedEstimateSamples: 0,
        monoRoutedAsDualMono: false,
        sourcePeak: null,
        exactSumHolds: null,
        mixdownWorstAbsError: null,
        mixdownExactFraction: null,
        mixdownPeak: null,
        elapsedMs: 0,
      };
      const source = activeDoc();
      if (!source) return empty;

      const sourceId = source.id;
      const startedAt = Date.now();
      const result = await runStemSeparation({ sourceDocId: sourceId });
      const elapsedMs = Date.now() - startedAt;
      if (!result.ok) {
        return { ...empty, status: result.status, message: result.message, elapsedMs };
      }

      const landing = landStems(result.output);
      const store = useAppStore.getState();
      const byId = new Map(store.documents.map((d) => [d.id, d]));
      const summary: StemSeparationSummary = {
        ...empty,
        ok: true,
        status: 'ok',
        documentNames: landing.documentIds.map((id) => byId.get(id)?.name ?? '(missing)'),
        sessionName: landing.sessionName,
        lengthSamples: result.output.lengthSamples,
        sampleRate: result.output.sampleRate,
        channelCount: result.output.channelCount,
        sanitisedEstimateSamples: result.output.sanitisedEstimateSamples,
        monoRoutedAsDualMono: landing.monoRoutedAsDualMono,
        sourcePeak: landing.sourcePeak,
        exactSumHolds: landing.exactSumHolds,
        elapsedMs,
      };

      // The identity can only be measured while the source is still open; if it
      // is gone, report nulls rather than a fabricated number (the same stance
      // `landStems` takes for `exactSumHolds`).
      const live = byId.get(sourceId);
      if (!live) return summary;

      const { channels: master } = renderMixdown(useSessionStore.getState().session, byId);
      const length = Math.min(master[0]?.length ?? 0, live.channels[0]?.length ?? 0);
      let worst = 0;
      let peak = 0;
      let exact = 0;
      let compared = 0;
      for (let side = 0; side < master.length; side++) {
        const got = master[side];
        const want = live.channels[side] ?? live.channels[0];
        for (let i = 0; i < length; i++) {
          const a = Math.abs(got[i]);
          if (a > peak) peak = a;
          const err = Math.abs(got[i] - want[i]);
          if (err > worst) worst = err;
          if (got[i] === want[i]) exact++;
          compared++;
        }
      }
      return {
        ...summary,
        mixdownWorstAbsError: worst,
        mixdownExactFraction: compared > 0 ? exact / compared : null,
        mixdownPeak: peak,
      };
    },

    // --- v1.9 flows (X7) --------------------------------------------------

    // The store action IS the clamp boundary (X2); this hook only forwards
    // and echoes. `curve` crosses as a string because the harness is plain
    // JS; the store runtime-checks it against FADE_CURVES exactly as it does
    // for any JS caller, so the cast adds no unchecked path.
    setClipFade: (clipId, edge, fade) => {
      useSessionStore
        .getState()
        .setClipFade(clipId, edge, {
          lengthSample: fade.lengthSample,
          curve: fade.curve as FadeCurve | undefined,
        });
      return fadeSummaries().find((s) => s.clipId === clipId) ?? null;
    },

    getClipFadeState: () => ({
      selectedClipId: useSessionStore.getState().selectedClipId,
      clips: fadeSummaries(),
    }),

    // The panel's Arm path: pair from the shared geometry predicate,
    // enablement from the store's own exported clampFadePair on exactly the
    // arguments setClipFade will use (refusing partial arms — a shortened
    // facing fade would fail rule 3 and silently render as solo fades), then
    // both facing fades written through the store.
    armCrossfade: (clipId, edge) => {
      const geo = pairOnEdge(clipId, edge);
      if (!geo) {
        return { ok: false, reason: 'no crossfade-capable pair on this edge', width: 0, outClipId: null, inClipId: null };
      }
      const grantsFull =
        clampFadePair(geo.a.fadeInSample ?? 0, geo.width, geo.a.lengthSample, 'in').fadeOut ===
          geo.width &&
        clampFadePair(geo.width, geo.b.fadeOutSample ?? 0, geo.b.lengthSample, 'out').fadeIn ===
          geo.width;
      if (!grantsFull) {
        return {
          ok: false,
          reason: 'an away-side fade leaves no room at this width',
          width: geo.width,
          outClipId: geo.a.id,
          inClipId: geo.b.id,
        };
      }
      const store = useSessionStore.getState();
      // R3: same single-entry bracket as the panel's Arm path.
      withSessionGesture('Arm crossfade', () => {
        store.setClipFade(geo.a.id, 'out', { lengthSample: geo.width });
        store.setClipFade(geo.b.id, 'in', { lengthSample: geo.width });
      });
      return { ok: true, reason: null, width: geo.width, outClipId: geo.a.id, inClipId: geo.b.id };
    },

    // The panel's Release path: BOTH facing fades cleared (0 normalises to
    // "no fade"), never one side alone.
    releaseCrossfade: (clipId, edge) => {
      const geo = pairOnEdge(clipId, edge);
      if (!geo) {
        return { ok: false, reason: 'no crossfade-capable pair on this edge', outClipId: null, inClipId: null };
      }
      const store = useSessionStore.getState();
      // R3: same single-entry bracket as the panel's Release path.
      withSessionGesture('Release crossfade', () => {
        store.setClipFade(geo.a.id, 'out', { lengthSample: 0 });
        store.setClipFade(geo.b.id, 'in', { lengthSample: 0 });
      });
      return { ok: true, reason: null, outClipId: geo.a.id, inClipId: geo.b.id };
    },

    // Obligation-1 instrument: the REAL MultitrackPlayer builds its REAL graph
    // (same play() code path as live playback, buffers baked by the same
    // buildClipBuffer) against an OfflineAudioContext, and the REAL Web Audio
    // engine performs every gain multiply and the summation. The unit parity
    // test proves player ≡ mixdown with the summation done in test arithmetic;
    // this closes the half it cannot: genuine Web Audio rendering.
    renderSessionWebAudio: async (overlap, probeIndices) => {
      const empty: WebAudioRenderSummary = {
        ok: false,
        reason: null,
        lengthSamples: 0,
        sampleRate: 0,
        worstAbsError: 0,
        worstAbsErrorInside: 0,
        worstAbsErrorOutside: 0,
        exactFraction: 0,
        exactFractionOutside: 0,
        webPeak: 0,
        mixPeak: 0,
        probes: [],
      };
      const session = useSessionStore.getState().session;
      const docs = new Map(useAppStore.getState().documents.map((d) => [d.id, d]));
      const { channels: mix, sampleRate } = renderMixdown(session, docs);
      const length = mix[0]?.length ?? 0;
      if (length === 0) return { ...empty, reason: 'empty session' };

      const offline = new OfflineAudioContext(2, length, sampleRate);
      // OfflineAudioContext.resume() REJECTS before startRendering() has been
      // called; the player fires a void ctx.resume() for the live context's
      // autoplay policy. Stub the instance method (an own property shadowing
      // the prototype) so the render is not accompanied by an unhandled
      // rejection — rendering is driven by startRendering() below, and the
      // stub changes nothing about the graph or the engine's arithmetic.
      (offline as unknown as { resume: () => Promise<void> }).resume = () => Promise.resolve();
      const player = new MultitrackPlayer({
        // The player's play()/buildClipBuffer path touches only BaseAudioContext
        // members OfflineAudioContext genuinely has (createGain, createBuffer,
        // createBufferSource, createChannelMerger, createChannelSplitter,
        // destination, currentTime, resume — stubbed above). The cast is wrong
        // only about AudioContext members this call path never reaches.
        createContext: () => offline as unknown as AudioContext,
      });
      player.play(0, session, docs);
      let rendered: AudioBuffer;
      try {
        rendered = await offline.startRendering();
      } catch (err) {
        return { ...empty, reason: `startRendering failed: ${String(err)}` };
      }

      let worst = 0;
      let worstIn = 0;
      let worstOut = 0;
      let exact = 0;
      let exactOut = 0;
      let outCount = 0;
      let webPeak = 0;
      let mixPeak = 0;
      const compared = 2 * length;
      for (let ch = 0; ch < 2; ch++) {
        const web = rendered.getChannelData(Math.min(ch, rendered.numberOfChannels - 1));
        const ref = mix[ch];
        for (let i = 0; i < length; i++) {
          const aw = Math.abs(web[i]);
          const am = Math.abs(ref[i]);
          if (aw > webPeak) webPeak = aw;
          if (am > mixPeak) mixPeak = am;
          const err = Math.abs(web[i] - ref[i]);
          const inside = overlap !== null && i >= overlap.start && i < overlap.end;
          if (err > worst) worst = err;
          if (inside) {
            if (err > worstIn) worstIn = err;
          } else {
            outCount++;
            if (err > worstOut) worstOut = err;
            if (web[i] === ref[i]) exactOut++;
          }
          if (web[i] === ref[i]) exact++;
        }
      }
      const probes = probeIndices
        .filter((i) => Number.isInteger(i) && i >= 0 && i < length)
        .map((index) => ({
          index,
          webL: rendered.getChannelData(0)[index],
          webR: rendered.getChannelData(Math.min(1, rendered.numberOfChannels - 1))[index],
          mixL: mix[0][index],
          mixR: mix[1][index],
        }));
      return {
        ok: true,
        reason: null,
        lengthSamples: length,
        sampleRate,
        worstAbsError: worst,
        worstAbsErrorInside: worstIn,
        worstAbsErrorOutside: worstOut,
        exactFraction: exact / compared,
        exactFractionOutside: outCount > 0 ? exactOut / outCount : 1,
        webPeak,
        mixPeak,
        probes,
      };
    },

    // F0 — plain-JSON automation snapshots. `automation: null` reports the
    // FIELD's absence (a `'automation' in track` check), so the smoke can
    // assert trap T9's "absent means none" against the real store after the
    // last key is deleted through the real gesture.
    getAutomationState: () => ({
      tracks: useSessionStore.getState().session.tracks.map((t) => ({
        trackId: t.id,
        automation: t.automation ? (JSON.parse(JSON.stringify(t.automation)) as AutomationLane[]) : null,
      })),
    }),

    // F0 — writes through the store's own action (THE write boundary); the
    // store rounds/clamps/validates exactly as for any other JS caller.
    upsertAutomationKey: (trackIndex, param, key, replacePositionSample) => {
      const tracks = useSessionStore.getState().session.tracks;
      const t = tracks[trackIndex];
      if (!t) return null;
      useSessionStore
        .getState()
        .upsertAutomationKey(
          t.id,
          param,
          key as { positionSample: number; value: number; curve?: FadeCurve },
          replacePositionSample
        );
      const after = useSessionStore.getState().session.tracks[trackIndex];
      return {
        automation: after.automation
          ? (JSON.parse(JSON.stringify(after.automation)) as AutomationLane[])
          : null,
      };
    },
  };

  (window as unknown as { __test: TestApi }).__test = testApi;
}
