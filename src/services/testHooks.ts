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
import { createClip } from '../multitrack/session';
import { useSessionStore } from '../multitrack/sessionStore';
import { mixdownSession as renderMixdown } from '../multitrack/mixdown';
import { parseSessionFileBytes, serializeSessionV3 } from '../multitrack/sessionFile';
import { clearClipWaveformCache } from '../components/Multitrack/clipWaveformCache';
import { runEffectOnSelection } from './effectRunner';
import { captureNoiseProfile, getNoiseProfile } from './noiseProfile';
import { encodeExport, openFilePath, saveDocument, type ExportOptions } from './fileService';
import { convertSampleRate } from './documentTools';
import { copySelection, pasteAtCursor } from './editOps';
import { getClipboard } from './clipboard';
import { getSpectralScale, toggleSpectralScale, type SpectralScale } from './spectralScale';
import { markSavePoint } from './undoHistory';
import { runTempoAnalysis } from './tempoAnalysis';
import { applyTempoChange } from './tempoService';
import { createRemixDocument, getRemixSession } from './remixService';
import { multitrackPlayer } from '../multitrack/MultitrackPlayer';
import { multitrackRecorder } from '../multitrack/multitrackRecord';

export interface TestStateSummary {
  docCount: number;
  activeName: string | null;
  length: number;
  sampleRate: number | null;
  channels: number | null;
  filePath: string | null;
  dirty: boolean | null;
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
        filePath: doc?.filePath ?? null,
        dirty: doc?.dirty ?? null,
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
    // There is deliberately NO `toggleBeatGrid` hook: the beat-grid waveform
    // OVERLAY (Task T6) is CUT by the plan's UI-scope ruling — the grid is
    // computed and cached, only its rendering was dropped — so there is no
    // display preference to toggle and nothing extra for the smoke to prove
    // paints.

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
  };

  (window as unknown as { __test: TestApi }).__test = testApi;
}
