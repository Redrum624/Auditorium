// TEST-ONLY window hooks for the scripted headed smoke (scripts/e2e-smoke.cjs).
// Installed by App.tsx only when the preload flags test mode (--auditorium-test,
// set from AUDITORIUM_TEST=1). Never present in a normal run.

import { createDocument, docLength, type AudioDocument } from '../audio/AudioDocument';
import { RecordingEngine } from '../audio/RecordingEngine';
import { encodeWav } from '../audio/wavCodec';
import { encodeOggOpus } from '../audio/oggOpusEncoder';
import { defaultParamsFor, getVisibleEffects } from '../effects/EffectRegistry';
import type { EffectParamValue } from '../effects/types';
import type { EditorView, Marker } from '../stores/appStore';
import { nextId, useAppStore } from '../stores/appStore';
import {
  clampFadePair,
  crossfadableOverlap,
  DEFAULT_FADE_CURVE,
} from '../multitrack/session';
import { placeDocumentsOnTrack } from '../multitrack/sessionInsert';
import { useSessionStore } from '../multitrack/sessionStore';
import { withSessionGesture } from '../multitrack/sessionUndo';
import type { AutomationLane, AutomationParam } from '../multitrack/automation';
import { mixdownSession as renderMixdown, resolveClipFadeSpecs } from '../multitrack/mixdown';
import { parseSessionFileBytes, serializeSessionV3 } from '../multitrack/sessionFile';
import { getEffectFailureCount, runEffectOnSelection } from './effectRunner';
import { captureNoiseProfile, getNoiseProfile } from './noiseProfile';
import {
  encodeExport,
  newDocument as newBlankDocument,
  openFilePath,
  saveDocument,
  type ExportOptions,
} from './fileService';
import { convertChannels as convertDocChannels, convertSampleRate } from './documentTools';
import {
  copySelection,
  cutSelection,
  deleteSelection,
  pasteAtCursor,
  silenceSelection,
  trimToSelection,
} from './editOps';
import { getClipboard } from './clipboard';
import { getSpectralScale, toggleSpectralScale, type SpectralScale } from './spectralScale';
import { getBeatGrid, isDownbeat } from './beatGrid';
import { isBeatGridVisible, toggleBeatGrid } from './beatGridDisplay';
import { editorSnapTargets } from '../components/Editor/editorSnapTargets';
import { SNAP_TOLERANCE_PX } from './snap';
import { isSnapEnabled, toggleSnap } from './snapPreference';
import { CONFIDENCE_LOW } from '../dsp/tempoCore';
import {
  getHistory,
  markSavePoint,
  redo as undoHistoryRedo,
  undo as undoHistoryUndo,
} from './undoHistory';
import { getTempo, runTempoAnalysis } from './tempoAnalysis';
import { applyTempoChange, checkVariableTempoChange } from './tempoService';
import { applyTimingAlignment, buildAlignPlan, suggestSyllableMarkers } from './timingAlignService';
import {
  VOCAL_CHAIN_STAGES,
  defaultStageSelection,
  runVocalChain,
  type VocalChainStageId,
} from './vocalChain';
import {
  COVER_CHAIN_STAGES,
  defaultCoverStageSelection,
  runCoverChain,
  type CoverChainStageId,
} from './coverChain';
import { COVER_JOURNEY_STAGES, runCoverJourney } from './coverJourney';
import { createRemixDocument, getRemixSession } from './remixService';
import { getStemModelState as readStemModelState, separateStems as runStemSeparation } from './stemService';
import {
  cancelTranscription,
  getTranscribeModelState as readTranscribeModelState,
  getTranscript,
  setTranscriptSpeakerCount as applyTranscriptSpeakerCount,
  transcribeDocument as runTranscription,
  type TranscribeProgress,
} from './transcribeService';
import {
  alignDocumentLyrics,
  getAlignModelState as readAlignModelState,
  replaceWord as spliceAlignedWord,
} from './alignLyricsService';
import {
  cancelVoiceRun,
  convertDocumentVoice,
  createVoiceProfile,
  getVoiceModelState as readVoiceModelState,
  type VoiceProgress,
} from './voiceService';
import { formatSrt, formatWebVtt } from './subtitleFormat';
import { landStems } from './stemLanding';
import { MultitrackPlayer, multitrackPlayer } from '../multitrack/MultitrackPlayer';
import { measureFirstPlayLatency as runFirstPlayLatency } from '../multitrack/firstPlayLatency';
import type { FirstPlayLatencyReport } from '../multitrack/firstPlayLatency';
import { multitrackRecorder } from '../multitrack/multitrackRecord';
import type { FadeCurve } from '../dsp/fades';
import { defaultSessionZoom } from '../multitrack/sessionZoom';

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
  /**
   * MT2 — the MULTITRACK SESSION's rate, which is not `sampleRate` above (that
   * one is the active DOCUMENT's).
   *
   * Added because the latency rig had to infer it: it compared the rate it had
   * passed to `newSession` against the active document's and called the two
   * "mismatched", which stopped being true the moment an empty session began
   * adopting the first document's rate — the verdict would have gone on
   * reporting a live resample branch over a session that has none. A rig that
   * infers the state it is measuring reports the inference, not the state.
   */
  sessionSampleRate: number;
}

/** F10's four before/after numbers, as plain JSON scalars. `null` is a real
 * answer for three of them — nothing sounding, no passage above digital
 * silence, no reference to measure a distance against. */
export interface CoverMetricsJson {
  gatedLevelDb: number | null;
  peakDb: number;
  spreadDb: number | null;
  noiseFloorDb: number | null;
  matchDistanceDb: number | null;
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
  /**
   * Running total of "Effect failed" dialogs raised in this renderer session.
   *
   * `applyEffect` cannot report a crash: `runEffectOnSelection` turns every
   * worker rejection into a fire-and-forget error dialog and resolves normally,
   * so a crashed effect and a clean refusal look identical from the script — the
   * promise settled, the document did not change. Read this either side of a run
   * and assert it did not move, and the two become distinguishable.
   */
  effectFailureCount(): number;
  setView(view: EditorView): void;
  captureNoisePrint(): void;
  getNoiseProfileSpectra(): number[][] | null;
  // --- L7: the edit surface a user touches every minute -----------------------
  /** Writes the store's selection exactly as the editor's drag gesture does.
   * NOT clamped here on purpose: `useEditorGestures.sampleAtClientX` clamps the
   * pointer to `[0, length]` BEFORE the store ever sees it, so the store's own
   * contract is "whatever the gesture committed". Callers pass UI-producible
   * ranges; the boundary smoke deliberately uses `end === length`, which is
   * exactly what a drag off the right edge produces. Returns what was stored. */
  setSelection(start: number, end: number): { start: number; end: number } | null;
  /** Clears it, the way a click without a drag does. */
  clearSelection(): void;
  /** One step FORWARD through the same history Ctrl+Y drives. */
  redoActive(): { length: number };
  /** The active document's history, as the History panel renders it. */
  getHistoryState(): { done: string[]; undone: string[] };
  /** The four selection edits behind Ctrl+X / Del / Trim / Silence, plus the
   * clipboard's other two ends, dispatched by name. */
  editOp(op: 'cut' | 'copy' | 'paste' | 'delete' | 'trim' | 'silence'): void;
  /** What the clipboard is holding, so a Cut's promise can be checked. */
  getClipboardInfo(): { length: number; sampleRate: number; channels: number } | null;
  /** Edit > Convert Channels (`documentTools.convertChannels`). */
  convertChannels(to: 1 | 2): void;
  /** File > New, through the same `fileService.newDocument` the dialog calls. */
  newDocument(sampleRate: number, channels: 1 | 2, seconds: number): void;
  /** The effects menu's OWN list — visible ids with their declared defaults, so
   * a sweep can never go stale against a hardcoded roster. */
  listEffects(): {
    id: string;
    name: string;
    category: string;
    params: Record<string, EffectParamValue>;
  }[];
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
  // --- R7 -----------------------------------------------------------------
  /** Drives the OPT-IN variable-rate Match Tempo end to end for the active
   * document, against its own cached beat grid, so the packaged run exercises
   * the real map, the real side channel and the real worker leg. Scalars and
   * flat arrays only, per the `getBeatGridState` precedent. `beatMarkers`
   * additionally proves the post-match grid is laid from the map's placed
   * positions rather than re-derived. */
  changeTempoVariable(
    targetBpm: number,
    addBeatMarkers?: boolean
  ): Promise<{
    ok: boolean;
    reason: string | null;
    beatCount: number;
    clampedCount: number;
    minLocalRatio: number;
    maxLocalRatio: number;
    lengthBefore: number;
    lengthAfter: number;
    plannedLength: number;
    beatMarkers: number[];
  }>;
  // --- F9 -----------------------------------------------------------------
  /** Drives Align Vocal Timing end to end for the active document: builds the
   * plan from the markers already placed and the cached beat grid, then applies
   * it. Scalars only, per the `getBeatGridState` precedent. */
  alignVocalTiming(
    division: number,
    strength: number
  ): Promise<{
    ok: boolean;
    reason: string | null;
    anchorCount: number;
    clampedCount: number;
    medianOffsetSamples: number;
    maxOffsetSamples: number;
    markersMoved: number;
    lengthBefore: number;
    lengthAfter: number;
    markerPositions: number[];
  }>;
  /** Runs the onset suggester over the active document's region. */
  suggestSyllables(sensitivity?: number): { added: number; truncated: boolean; analysedSeconds: number } | null;
  // --- F7 -----------------------------------------------------------------
  /** Runs the Vocal Chain over the active document through the SAME service the
   * dialog calls, so the packaged smoke exercises the real derivations, the
   * real worker leg and the single undo entry. `overrides` flips named stages;
   * everything else keeps its shipped default. Scalars and flat records only,
   * per the `getBeatGridState` precedent. */
  /** One undo step on the ACTIVE document, through the same history the
   * Ctrl+Z shortcut drives. Added for F7, whose whole point is that a
   * ten-stage pass reverts in one. */
  undoActive(): { length: number };
  // --- F10 -----------------------------------------------------------------
  /** Runs the Cover Chain over the active document through the SAME service the
   * dialog calls, so the packaged smoke exercises the real derivations, three
   * real DSP workers back to back, and the single undo entry. `referenceName`
   * names the OPEN document to match against (the separated original vocal);
   * `null` runs with no reference, which is the path where every matching stage
   * declines. `overrides` flips named stages; everything else keeps its shipped
   * default. Scalars and flat records only, per the `getBeatGridState`
   * precedent. */
  runCoverChain(
    referenceName: string | null,
    overrides?: Record<string, boolean>
  ): Promise<{
    ok: boolean;
    applied: boolean;
    undoDepth: number;
    undoLabel: string | null;
    referenceName: string | null;
    /** True when the reference document's samples are bit-identical to what
     * they were before the run. The chain READS the reference; a run that
     * detached or edited it would be a defect the unit suite's synchronous
     * worker mock cannot see, because only the real worker transfers buffers. */
    referenceIntact: boolean | null;
    lengthBefore: number;
    lengthAfter: number;
    before: CoverMetricsJson;
    after: CoverMetricsJson;
    reference: CoverMetricsJson | null;
    stages: {
      id: string;
      status: string;
      reason: string | null;
      warning: string | null;
      derived: { label: string; value: string }[];
      detail: string | null;
      identicalFraction: number | null;
      /** The peaks either side of THIS stage, so a caller can observe what the
       * limiter was handed rather than only what the whole chain produced. */
      peakBeforeDb: number | null;
      peakAfterDb: number | null;
      /** The realised match curve, per band — Ruling B's claim, measured in the
       * packaged app rather than against the predictor alone. */
      eqBands: {
        centreHz: number;
        status: string;
        targetDb: number;
        realisedDb: number;
        bandGainDb: number;
        bounded: boolean;
      }[];
      eqWorstErrorDb: number | null;
    }[];
    /** The registry's own ids and manual set, so a caller compares the report
     * against the stage LIST rather than a hardcoded count — a count rots the
     * moment a stage is added, and it has, twice. */
    registryStageIds: string[];
    registryManualIds: string[];
  }>;
  // --- CP1 -----------------------------------------------------------------
  /**
   * Runs the WHOLE Cover journey — separate, clean, align, match, place, smooth
   * — over two open documents, through the same service the dialog calls.
   *
   * What only the packaged app can prove, and the reason this hook exists at
   * all: the unit suite spies on the six sub-services, so it can show they are
   * called in order but not that they COMPOSE. This drives the real separation
   * (or its reuse), two real chains over real DSP workers, the real alignment
   * over real audio, and a real session build — and reports what came out the
   * far end. Scalars and flat records only, per the `getBeatGridState`
   * precedent.
   */
  runCoverJourney(
    songName: string,
    takeName: string
  ): Promise<{
    ok: boolean;
    completed: boolean;
    cancelledAt: string | null;
    /** True when an existing separation of the song was reused. */
    separationReused: boolean | null;
    /** The alignment's own numbers, or nulls when it could not measure. */
    alignmentOffsetSeconds: number | null;
    alignmentConfident: boolean | null;
    alignmentPeakCorrelation: number | null;
    alignmentProminence: number | null;
    alignmentRefused: boolean;
    /** V3. True when the take was placed at a lag the pass could not fully
     * believe — the 'weak' and 'ambiguous' outcomes, which now place rather
     * than offer. `alignmentRefused` and this are mutually exclusive, and both
     * false is the believed arm. */
    alignmentAutoPlaced: boolean;
    /** Where the two clips actually landed, in SESSION samples. */
    sessionName: string | null;
    sessionTrackCount: number;
    /** The session's own rate — the INSTRUMENTAL's, which is the song's and not
     * necessarily the take's. A caller converting the reported offset into
     * samples must use this one; assuming 44.1 kHz is how the first version of
     * the packaged step came to compute a placement the app never made. */
    sessionRate: number | null;
    takeStartSample: number | null;
    instrumentalStartSample: number | null;
    shiftedSamples: number | null;
    fadeInSample: number | null;
    fadeOutSample: number | null;
    /** The summed peak measured BEFORE the master bus's clamp. */
    summedPeakDb: number | null;
    overCeiling: boolean | null;
    /** Every undo entry the pass left, in order. */
    undoEntries: string[];
    stages: {
      id: string;
      status: string;
      reason: string | null;
      warning: string | null;
      derived: { label: string; value: string }[];
      /** How many stages the NESTED chain reported, when this stage is one —
       * the structural proof that the nesting is real rather than flattened. */
      nestedStageCount: number | null;
    }[];
    /** The registry's own ids, so a caller compares against the stage LIST
     * rather than a hardcoded count. */
    registryStageIds: string[];
  }>;
  runVocalChain(overrides?: Record<string, boolean>): Promise<{
    ok: boolean;
    applied: boolean;
    undoDepth: number;
    undoLabel: string | null;
    lengthBefore: number;
    lengthAfter: number;
    before: { rmsDb: number; peakDb: number; crestDb: number; noiseFloorDb: number | null };
    after: { rmsDb: number; peakDb: number; crestDb: number; noiseFloorDb: number | null };
    stages: {
      id: string;
      status: string;
      reason: string | null;
      derived: { label: string; value: string }[];
      detail: string | null;
      identicalFraction: number | null;
    }[];
    /** The registry's own stage ids, in registry order, so a smoke assertion
     * compares the report against the stage LIST rather than a hardcoded count
     * — a count rots the moment a stage is added, and it did (F6's `lyrics`
     * stage broke a `=== 11` assertion). */
    registryStageIds: string[];
    /** The subset of {@link registryStageIds} with no effect id: the stages the
     * chain reports on but does not apply. */
    registryManualIds: string[];
  }>;
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
  /** The active remix's PIN state (R4b): which joins are pinned, which the
   * current plan dropped, the planner's own report of why, and the roll index
   * the plan was produced at. The smoke drives the Pin and Re-roll BUTTONS in
   * the panel and reads this to assert the pin actually survived — `rollIndex`
   * is what tells it the asynchronous re-plan has landed. Null when the active
   * document is not a remix. */
  getRemixPinState(): {
    lockedJoins: string[];
    lockedJoinsDropped: string[];
    pinMode: string | null;
    pinSatisfied: string[];
    pinDropped: { key: string; reason: string }[];
    rollIndex: number;
    plansInWorker: boolean;
  } | null;
  // --- v1.7 flows ---------------------------------------------------------
  getStemModelState(): Promise<{ downloaded: boolean; bytes: number | null; expectedBytes: number }>;
  separateStems(): Promise<StemSeparationSummary>;
  // --- F4b flows (transcription) -----------------------------------------
  getTranscribeModelState(): Promise<{ downloaded: boolean; bytes: number | null; expectedBytes: number }>;
  /** Transcribes the ACTIVE document, bypassing TranscribeDialog. Pass a
   * count to assert a speaker count, or null/omit for auto-detection. */
  transcribeActive(speakerCount?: number | null): Promise<TranscriptionSummary>;
  /** Starts a transcription of the ACTIVE document and cancels it after
   * `delayMs`. Proves Cancel against a REAL utility process. */
  transcribeActiveThenCancel(delayMs: number): Promise<TranscriptionSummary>;
  // --- F3 flows (voice changer) ------------------------------------------
  getVoiceModelState(): Promise<{ downloaded: boolean; bytes: number | null; expectedBytes: number }>;
  /** Saves a voice profile from a slice of the ACTIVE document, bypassing
   * VoiceChangerDialog's native file picker (which a script cannot drive).
   * `consentAffirmed` is passed THROUGH, not forced: the smoke calls it with
   * `false` first and must see the refusal, which is how the packaged build
   * proves the consent gate survives bundling. */
  createVoiceProfileFrom(
    name: string,
    startSample: number,
    endSample: number,
    consentAffirmed: boolean
  ): Promise<VoiceProfileSummary>;
  /** Converts the ACTIVE document with a saved profile. `consentAffirmed` is
   * passed through for the same reason as above. */
  convertActiveVoice(profileId: string, consentAffirmed: boolean): Promise<VoiceConversionSummary>;
  /** Starts a conversion of the ACTIVE document and cancels it after
   * `delayMs`. Proves Cancel against a REAL utility process. */
  convertActiveVoiceThenCancel(profileId: string, delayMs: number): Promise<VoiceConversionSummary>;
  // --- F6 flows (Align Lyrics) -------------------------------------------
  getAlignModelState(): Promise<{ downloaded: boolean; bytes: number | null; expectedBytes: number }>;
  /** Aligns `text` to the ACTIVE document, bypassing AlignLyricsDialog.
   * Returns scalars and word spans only — no store handles. */
  alignActiveLyrics(text: string): Promise<AlignLyricsSummary>;
  /** Records `seconds` from the (fake-device) microphone and KEEPS the buffer
   * in memory as the pending replacement. Deliberately does NOT create a
   * document: the shipped dialog does not either, and a hook that did would
   * be testing a different flow. */
  recordReplacementSeconds(seconds: number): Promise<{ length: number; sampleRate: number; rms: number }>;
  /** Splices the buffer `recordReplacementSeconds` captured over the aligned
   * span of `wordIndex`. `opts.matchPitch` is the splice request's own option
   * (`replaceWord` forwards it, wordSplice defaults it ON like the dialog):
   * the smoke's degraded path turns it off, because median-F0 arithmetic
   * between a synthetic fixture and the fake device's beep demands stretches
   * the time-fit is designed to refuse. Left unset, the call is byte-for-byte
   * what it always was. */
  replaceAlignedWord(wordIndex: number, opts?: { matchPitch?: boolean } | null): Promise<ReplaceWordSummary>;
  /** Re-clusters the active document's stored transcript. Returns the new
   * speaker assignment, or null when there is no transcript. */
  setTranscriptSpeakers(count: number | null): {
    speakerCount: number;
    requestedSpeakerCount: number | null;
    speakers: (number | null)[];
  } | null;
  /** Writes the active document's transcript to `outPath` with the SAME
   * formatter `exportTranscript` uses, skipping only the native save dialog
   * (the `exportActive` precedent). */
  exportTranscriptTo(format: 'srt' | 'vtt', outPath: string): Promise<boolean>;
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

/** Plain-JSON result of the transcription hooks. Typed arrays do not survive
 * Playwright's `page.evaluate` bridge, so everything here is JSON-safe. */
export interface TranscriptionSummary {
  ok: boolean;
  /** `'ok'` on success, otherwise the service's own `TranscribeStatus`. */
  status: string;
  message: string | null;
  segmentCount: number;
  speakerCount: number;
  requestedSpeakerCount: number | null;
  language: string | null;
  languageProbability: number | null;
  unembeddedSegments: number;
  unlabelledSegments: number;
  /** The DOCUMENT's rate; segment positions are in its samples. */
  sampleRate: number;
  lengthSamples: number;
  segments: {
    index: number;
    startSample: number;
    endSample: number;
    text: string;
    speaker: number | null;
  }[];
  elapsedMs: number;
  /** How many progress events the host actually streamed — 0 would mean the
   * child never reported, which a `done`-only assertion would not notice. */
  progressEvents: number;
  /** Furthest `done` seen in the transcribe stage, and the total it was
   * reported against, both in 16 kHz samples. */
  maxTranscribeDone: number;
  transcribeTotal: number;
  /** Distinct phases the service passed through, in first-seen order. */
  phasesSeen: string[];
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

/** Plain-JSON result of the `createVoiceProfileFrom` hook. */
export interface VoiceProfileSummary {
  ok: boolean;
  /** `'ok'` on success, otherwise the service's own `VoiceStatus`. */
  status: string;
  message: string | null;
  profileId: string | null;
  profileName: string | null;
  /** Length of the stored embedding — 256 when the host really ran. */
  embeddingLength: number;
  /** L2 norm of the embedding: a degenerate (all-zero) target would be 0. */
  embeddingNorm: number;
  persistError: string | null;
}

/** Plain-JSON result of `alignActiveLyrics` (F6). Scalars and spans only. */
export interface AlignLyricsSummary {
  ok: boolean;
  status: string;
  message: string | null;
  elapsedMs: number;
  wordCount: number;
  droppedWords: string[];
  verdict: 'match' | 'weak' | null;
  medianWordScore: number;
  pathScore: number;
  chunked: boolean;
  regionStart: number;
  regionEnd: number;
  sampleRate: number;
  words: { text: string; startSample: number; endSample: number }[];
}

/** Plain-JSON result of `replaceAlignedWord` (F6). */
export interface ReplaceWordSummary {
  ok: boolean;
  status: string;
  message: string | null;
  wordText: string | null;
  wordStart: number;
  wordEnd: number;
  regionStart: number;
  regionEnd: number;
  trimmedSamples: number;
  stretchRatio: number;
  gainDb: number;
  pitchShiftSemitones: number;
  headSeamSamples: number;
  tailSeamSamples: number;
  lengthDelta: number;
}

/** Plain-JSON result of the `convertActiveVoice` hooks. */
export interface VoiceConversionSummary {
  ok: boolean;
  status: string;
  message: string | null;
  docId: string | null;
  docName: string | null;
  sanitisedSamples: number;
  /** Measured off the LANDED document, not reported by the service. */
  landedLengthSamples: number;
  landedSampleRate: number;
  landedChannelCount: number;
  landedPeak: number;
  landedRmsDb: number;
  docCountDelta: number;
  elapsedMs: number;
  progressEvents: number;
  phasesSeen: string[];
  maxFraction: number;
}

/**
 * The body behind `convertActiveVoice` / `convertActiveVoiceThenCancel`: one
 * real run through the real service, with the progress stream RECORDED so the
 * smoke can prove the host streamed rather than only that it finished, and
 * with the landed document measured here rather than taken on trust.
 */
async function runVoiceConversionHook(
  profileId: string,
  consentAffirmed: boolean,
  cancelAfterMs: number | null
): Promise<VoiceConversionSummary> {
  const empty: VoiceConversionSummary = {
    ok: false,
    status: 'no-document',
    message: null,
    docId: null,
    docName: null,
    sanitisedSamples: 0,
    landedLengthSamples: 0,
    landedSampleRate: 0,
    landedChannelCount: 0,
    landedPeak: 0,
    landedRmsDb: -Infinity,
    docCountDelta: 0,
    elapsedMs: 0,
    progressEvents: 0,
    phasesSeen: [],
    maxFraction: 0,
  };
  const doc = activeDoc();
  if (!doc) return empty;
  const before = useAppStore.getState().documents.length;

  let progressEvents = 0;
  let maxFraction = 0;
  const phasesSeen: string[] = [];
  const onProgress = (p: VoiceProgress): void => {
    progressEvents++;
    if (!phasesSeen.includes(p.phase)) phasesSeen.push(p.phase);
    if (p.fraction > maxFraction) maxFraction = p.fraction;
  };

  const timer =
    cancelAfterMs === null ? null : setTimeout(() => void cancelVoiceRun(), cancelAfterMs);
  const startedAt = Date.now();
  const result = await convertDocumentVoice({ docId: doc.id, profileId, consentAffirmed, onProgress });
  const elapsedMs = Date.now() - startedAt;
  if (timer !== null) clearTimeout(timer);

  const docCountDelta = useAppStore.getState().documents.length - before;
  const observed = { elapsedMs, progressEvents, phasesSeen, maxFraction, docCountDelta };
  if (!result.ok) {
    return { ...empty, ...observed, status: result.status, message: result.message };
  }
  const landed = useAppStore.getState().documents.find((d) => d.id === result.docId) ?? null;
  const ch = landed?.channels[0] ?? new Float32Array(0);
  let peak = 0;
  let sumSquares = 0;
  for (let i = 0; i < ch.length; i++) {
    const a = Math.abs(ch[i]);
    if (a > peak) peak = a;
    sumSquares += ch[i] * ch[i];
  }
  return {
    ...empty,
    ...observed,
    ok: true,
    status: 'ok',
    docId: result.docId,
    docName: result.docName,
    sanitisedSamples: result.sanitisedSamples,
    landedLengthSamples: ch.length,
    landedSampleRate: landed?.sampleRate ?? 0,
    landedChannelCount: landed?.channels.length ?? 0,
    landedPeak: peak,
    landedRmsDb:
      ch.length === 0 ? -Infinity : 20 * Math.log10(Math.max(Math.sqrt(sumSquares / ch.length), 1e-12)),
  };
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

/**
 * The take `recordReplacementSeconds` captured, held in memory until
 * `replaceAlignedWord` consumes it — the shipped dialog holds it in component
 * state for the same span, and a hook that landed it as a document instead
 * would be exercising a flow the app does not have.
 */
let pendingReplacement: { channels: Float32Array[]; sampleRate: number } | null = null;

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

/**
 * The body behind `transcribeActive` / `transcribeActiveThenCancel`: one real
 * run through the real service, with the progress stream RECORDED so the smoke
 * can prove the host actually streamed rather than only that it finished.
 *
 * `cancelAfterMs` non-null schedules a `cancelTranscription()` that many
 * milliseconds in — the only way to exercise Cancel against a live utility
 * process from a script.
 */
async function runTranscriptionHook(
  speakerCount: number | undefined,
  cancelAfterMs: number | null
): Promise<TranscriptionSummary> {
  const empty: TranscriptionSummary = {
    ok: false,
    status: 'no-document',
    message: null,
    segmentCount: 0,
    speakerCount: 0,
    requestedSpeakerCount: null,
    language: null,
    languageProbability: null,
    unembeddedSegments: 0,
    unlabelledSegments: 0,
    sampleRate: 0,
    lengthSamples: 0,
    segments: [],
    elapsedMs: 0,
    progressEvents: 0,
    maxTranscribeDone: 0,
    transcribeTotal: 0,
    phasesSeen: [],
  };
  const doc = activeDoc();
  if (!doc) return empty;

  let progressEvents = 0;
  let maxTranscribeDone = 0;
  let transcribeTotal = 0;
  const phasesSeen: string[] = [];
  const onProgress = (p: TranscribeProgress): void => {
    progressEvents++;
    if (!phasesSeen.includes(p.phase)) phasesSeen.push(p.phase);
    if (p.phase === 'transcribing') {
      if (p.done > maxTranscribeDone) maxTranscribeDone = p.done;
      if (p.total > transcribeTotal) transcribeTotal = p.total;
    }
  };

  const timer =
    cancelAfterMs === null ? null : setTimeout(() => void cancelTranscription(), cancelAfterMs);
  const startedAt = Date.now();
  const result = await runTranscription({ docId: doc.id, speakerCount, onProgress });
  const elapsedMs = Date.now() - startedAt;
  if (timer !== null) clearTimeout(timer);

  const observed = { elapsedMs, progressEvents, maxTranscribeDone, transcribeTotal, phasesSeen };
  if (!result.ok) {
    return { ...empty, ...observed, status: result.status, message: result.message };
  }
  const t = result.transcript;
  return {
    ...empty,
    ...observed,
    ok: true,
    status: 'ok',
    segmentCount: t.segments.length,
    speakerCount: t.speakerCount,
    requestedSpeakerCount: t.requestedSpeakerCount,
    language: t.language,
    languageProbability: t.languageProbability,
    unembeddedSegments: t.unembeddedSegments,
    unlabelledSegments: t.unlabelledSegments,
    sampleRate: t.sampleRate,
    lengthSamples: t.lengthSamples,
    segments: t.segments.map((s) => ({
      index: s.index,
      startSample: s.startSample,
      endSample: s.endSample,
      text: s.text,
      speaker: s.speaker,
    })),
  };
}

export function installTestHooks(): void {
  if (typeof window === 'undefined') return;

  const testApi: TestApi = {
    // F11-4: openFilePath now answers with the id of the document it added
    // (the lane drop places THAT document). The harness only awaits the open,
    // so the id is dropped here rather than widening the test API.
    openPath: async (path) => {
      await openFilePath(path);
    },

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
        sessionSampleRate: useSessionStore.getState().session.sampleRate,
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

    effectFailureCount: () => getEffectFailureCount(),

    setView: (view) => useAppStore.getState().setView(view),

    captureNoisePrint: () => captureNoiseProfile(),

    getNoiseProfileSpectra: () => {
      const profile = getNoiseProfile();
      return profile ? profile.spectra.map((s) => Array.from(s)) : null;
    },

    // --- L7: selection, history and the edit menu -------------------------
    //
    // Until L7 nothing in the packaged smoke could WRITE a selection, so every
    // packaged effect run was whole-document and the whole region-boundary
    // defect class had no packaged coverage at all — in an editor whose primary
    // verb is "select, then process". These hooks are the smallest set that
    // closes it, and each is a thin pass-through to the exact production call
    // the corresponding menu item / gesture makes — none of them reimplements
    // an edit, because a hook that did would only be testing itself.
    setSelection: (start, end) => {
      const sel = { start, end };
      useAppStore.getState().setSelection(sel);
      return sel;
    },

    clearSelection: () => useAppStore.getState().setSelection(null),

    redoActive: () => {
      const doc = activeDoc();
      if (doc) undoHistoryRedo(doc.id);
      const after = activeDoc();
      return { length: after ? docLength(after) : 0 };
    },

    getHistoryState: () => {
      const doc = activeDoc();
      if (!doc) return { done: [], undone: [] };
      const history = getHistory(doc.id);
      return { done: [...history.done], undone: [...history.undone] };
    },

    // Dispatch by name rather than six hooks: every branch is one call to the
    // editOps function the menu command already calls, with no logic of its own
    // (a hook that reimplemented an edit would be testing itself).
    editOp: (op) => {
      switch (op) {
        case 'cut':
          cutSelection();
          return;
        case 'copy':
          copySelection();
          return;
        case 'paste':
          pasteAtCursor();
          return;
        case 'delete':
          deleteSelection();
          return;
        case 'trim':
          trimToSelection();
          return;
        case 'silence':
          silenceSelection();
          return;
      }
    },

    getClipboardInfo: () => {
      const clip = getClipboard();
      if (!clip) return null;
      return {
        length: clip.channels[0]?.length ?? 0,
        sampleRate: clip.sampleRate,
        channels: clip.channels.length,
      };
    },

    convertChannels: (to) => {
      const doc = activeDoc();
      if (!doc) return;
      convertDocChannels(doc.id, to);
    },

    newDocument: (sampleRate, channels, seconds) => {
      newBlankDocument({
        name: `Untitled ${nextId('untitled').split('-')[1]}`,
        sampleRate,
        channels,
        durationSeconds: seconds,
      });
    },

    // getVisibleEffects() + defaultParamsFor() — the registry's OWN roster, the
    // same pair `menuActions.ts` builds the Effects menu from. A sweep that
    // hardcoded the list would go stale the moment an effect is added, which is
    // how a stale count broke a release here before.
    listEffects: () =>
      getVisibleEffects().map((def) => ({
        id: def.id,
        name: def.name,
        category: def.category,
        params: defaultParamsFor(def.id),
      })),

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
    // (session samples), through the SHARED placement path — so this hook sees
    // the same conversion, and the same empty-session rate adoption (MT2), that
    // Insert Active File and a lane drop see. `startSample` and `lengthSample`
    // come back in the session's rate AFTER any adoption, which is why they are
    // reported rather than echoed.
    insertActiveDocAsClip: (trackIndex, startSample) => {
      const doc = activeDoc();
      if (!doc) return null;
      const track = useSessionStore.getState().session.tracks[trackIndex];
      if (!track) return null;
      const [placed] = placeDocumentsOnTrack([doc], track.id, startSample, { select: false });
      return placed ?? null;
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
        // MT1 (C1): fitted, not the hardcoded 512 — see sessionFile's twin. This
        // hook is how the smoke and the walker open a session, so while it wrote
        // 512 every rig assertion about the multitrack was made against a zoom
        // no user would ever see.
        mtZoom: defaultSessionZoom(result.session),
        mtPlayState: 'stopped',
        mtPlayheadSample: 0,
      });
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

    // R7. Drives the real applyTempoChange down its VARIABLE branch, using the
    // document's own cached beat grid as the confirmed grid the dialog would
    // supply. `plannedLength` is what checkVariableTempoChange previewed BEFORE
    // the run, so the smoke can assert the preview and the result agree — the
    // property that makes the dialog's readout trustworthy rather than
    // decorative.
    changeTempoVariable: async (targetBpm, addBeatMarkers = false) => {
      const doc = activeDoc();
      const lengthBefore = doc ? docLength(doc) : 0;
      const empty = {
        ok: false,
        reason: 'no-document',
        beatCount: 0,
        clampedCount: 0,
        minLocalRatio: 0,
        maxLocalRatio: 0,
        lengthBefore,
        lengthAfter: lengthBefore,
        plannedLength: 0,
        beatMarkers: [] as number[],
      };
      if (!doc) return empty;
      const entry = getTempo(doc);
      if (!entry || entry.beatSamples.length < 2) {
        return { ...empty, reason: 'no-grid' };
      }

      const req = {
        sourceBpm: entry.bpm ?? targetBpm,
        targetBpm,
        addBeatMarkers,
        variableRate: { beatSamples: entry.beatSamples },
      };
      const planned = checkVariableTempoChange(req);
      if (!planned.ok) return { ...empty, reason: planned.reason };

      const outcome = await applyTempoChange(req);
      const after = activeDoc();
      const markers = after ? (useAppStore.getState().markers[after.id] ?? []) : [];
      return {
        ok: outcome.ok,
        reason: outcome.reason ?? null,
        beatCount: planned.plan.beatCount,
        clampedCount: planned.plan.clampedCount,
        minLocalRatio: planned.plan.map.minLocalRatio,
        maxLocalRatio: planned.plan.map.maxLocalRatio,
        lengthBefore,
        lengthAfter: after ? docLength(after) : 0,
        plannedLength: planned.plan.outLength,
        beatMarkers: markers
          .filter((m) => m.name.startsWith('Beat '))
          .map((m) => m.positionSample)
          .sort((a, b) => a - b),
      };
    },

    // F9. Drives buildAlignPlan + applyTimingAlignment for the active document,
    // bypassing AlignTimingDialog — so the smoke test exercises the same
    // service the dialog calls, including the marker remap.
    alignVocalTiming: async (division, strength) => {
      const before = activeDoc();
      const lengthBefore = before ? docLength(before) : 0;
      const empty = {
        ok: false,
        reason: 'no-document',
        anchorCount: 0,
        clampedCount: 0,
        medianOffsetSamples: 0,
        maxOffsetSamples: 0,
        markersMoved: 0,
        lengthBefore,
        lengthAfter: lengthBefore,
        markerPositions: [] as number[],
      };
      if (!before) return empty;

      const planned = buildAlignPlan({ division, strength });
      if (!planned.ok) return { ...empty, reason: planned.reason };

      const outcome = await applyTimingAlignment({ plan: planned.plan, strength });
      const after = activeDoc();
      return {
        ok: outcome.ok,
        reason: outcome.ok ? null : outcome.reason,
        anchorCount: planned.plan.anchors.length,
        clampedCount: planned.plan.clampedIndices.length,
        medianOffsetSamples: planned.plan.medianOffsetSamples,
        maxOffsetSamples: planned.plan.maxOffsetSamples,
        markersMoved: outcome.ok ? outcome.markersMoved : 0,
        lengthBefore,
        lengthAfter: after ? docLength(after) : 0,
        markerPositions: (useAppStore.getState().markers[before.id] ?? []).map(
          (m) => m.positionSample
        ),
      };
    },

    suggestSyllables: (sensitivity) => suggestSyllableMarkers({ sensitivity }),

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

    // R4b. Flattened rather than handing back `pinReport` itself, because this
    // crosses `page.evaluate`'s structured clone in the smoke and a plain
    // shape is what survives it unambiguously.
    getRemixPinState: () => {
      const doc = activeDoc();
      const session = doc ? getRemixSession(doc.id) : null;
      if (!session) return null;
      return {
        lockedJoins: session.lockedJoins.slice(),
        lockedJoinsDropped: session.lockedJoinsDropped.slice(),
        pinMode: session.pinReport?.mode ?? null,
        pinSatisfied: session.pinReport?.satisfied.slice() ?? [],
        pinDropped: (session.pinReport?.dropped ?? []).map((d) => ({ key: d.key, reason: d.reason })),
        rollIndex: session.rollIndex,
        plansInWorker: session.plansInWorker,
      };
    },

    // --- v1.7 flows -------------------------------------------------------

    // Whether the 166 MB separation model is already on disk. The smoke's stem
    // step is gated on this: the model is downloaded on first use and is NOT in
    // the repo, so a machine without it must REPORT a skip, never pass quietly.
    getStemModelState: () => readStemModelState(),

    // --- F4b flows --------------------------------------------------------

    // Whether the ~323 MB six-file model set is already on disk. The smoke's
    // transcription step is gated on this exactly as the stem step is: the
    // files are downloaded on first use and are NOT in the repo, so a machine
    // without them must REPORT a skip, never pass quietly.
    getTranscribeModelState: () => readTranscribeModelState(),

    transcribeActive: (speakerCount) => runTranscriptionHook(speakerCount ?? undefined, null),
    transcribeActiveThenCancel: (delayMs) => runTranscriptionHook(undefined, delayMs),

    // --- F3 flows (voice changer) -----------------------------------------

    // Whether the 161 MB two-file model set is already on disk. The smoke's
    // voice step is gated on this exactly as the stem and transcription steps
    // are: the files are downloaded on first use and are NOT in the repo, so
    // a machine without them must REPORT a skip, never pass quietly.
    getVoiceModelState: () => readVoiceModelState(),

    createVoiceProfileFrom: async (name, startSample, endSample, consentAffirmed) => {
      const doc = activeDoc();
      const empty: VoiceProfileSummary = {
        ok: false,
        status: 'no-document',
        message: null,
        profileId: null,
        profileName: null,
        embeddingLength: 0,
        embeddingNorm: 0,
        persistError: null,
      };
      if (!doc) return empty;
      const lo = Math.max(0, Math.min(startSample, doc.channels[0]?.length ?? 0));
      const hi = Math.max(lo, Math.min(endSample, doc.channels[0]?.length ?? 0));
      const result = await createVoiceProfile({
        name,
        channels: doc.channels.map((c) => c.slice(lo, hi)),
        sampleRate: doc.sampleRate,
        sourceName: doc.name,
        consentAffirmed,
      });
      if (!result.ok) return { ...empty, status: result.status, message: result.message };
      let norm = 0;
      for (let i = 0; i < result.profile.embedding.length; i++) {
        norm += result.profile.embedding[i] * result.profile.embedding[i];
      }
      return {
        ...empty,
        ok: true,
        status: 'ok',
        profileId: result.profile.id,
        profileName: result.profile.name,
        embeddingLength: result.profile.embedding.length,
        embeddingNorm: Math.sqrt(norm),
        persistError: result.persistError,
      };
    },

    convertActiveVoice: (profileId, consentAffirmed) =>
      runVoiceConversionHook(profileId, consentAffirmed, null),
    convertActiveVoiceThenCancel: (profileId, delayMs) =>
      runVoiceConversionHook(profileId, true, delayMs),

    // --- F6 flows (Align Lyrics) ------------------------------------------

    // Whether the 378 MB two-file model set is already on disk. The smoke's
    // Align Lyrics step is gated on this exactly as the stem, transcription
    // and voice steps are.
    getAlignModelState: () => readAlignModelState(),

    alignActiveLyrics: async (text) => {
      const empty: AlignLyricsSummary = {
        ok: false,
        status: 'no-document',
        message: null,
        elapsedMs: 0,
        wordCount: 0,
        droppedWords: [],
        verdict: null,
        medianWordScore: 0,
        pathScore: 0,
        chunked: false,
        regionStart: 0,
        regionEnd: 0,
        sampleRate: 0,
        words: [],
      };
      const doc = activeDoc();
      if (!doc) return empty;
      const startedAt = Date.now();
      const result = await alignDocumentLyrics({ docId: doc.id, text });
      const elapsedMs = Date.now() - startedAt;
      if (!result.ok) {
        return { ...empty, status: result.status, message: result.message, elapsedMs };
      }
      const a = result.alignment;
      return {
        ok: true,
        status: 'ok',
        message: null,
        elapsedMs,
        wordCount: a.words.length,
        droppedWords: a.droppedWords,
        verdict: a.verdict,
        medianWordScore: a.medianWordScore,
        pathScore: a.pathScore,
        chunked: a.chunked,
        regionStart: a.regionStart,
        regionEnd: a.regionEnd,
        sampleRate: a.sampleRate,
        words: a.words.map((w) => ({ text: w.text, startSample: w.startSample, endSample: w.endSample })),
      };
    },

    recordReplacementSeconds: async (seconds) => {
      const engine = new RecordingEngine();
      const doc = activeDoc();
      await engine.start({ channels: 1, sampleRate: doc ? doc.sampleRate : 44100 });
      await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
      const { channels, sampleRate } = await engine.stop();
      pendingReplacement = { channels, sampleRate };
      let sum = 0;
      let count = 0;
      for (const ch of channels) {
        for (let i = 0; i < ch.length; i++) sum += ch[i] * ch[i];
        count += ch.length;
      }
      return {
        length: channels[0]?.length ?? 0,
        sampleRate,
        rms: count > 0 ? Math.sqrt(sum / count) : 0,
      };
    },

    replaceAlignedWord: async (wordIndex, opts) => {
      const empty: ReplaceWordSummary = {
        ok: false,
        status: 'no-document',
        message: null,
        wordText: null,
        wordStart: 0,
        wordEnd: 0,
        regionStart: 0,
        regionEnd: 0,
        trimmedSamples: 0,
        stretchRatio: 0,
        gainDb: 0,
        pitchShiftSemitones: 0,
        headSeamSamples: 0,
        tailSeamSamples: 0,
        lengthDelta: 0,
      };
      const doc = activeDoc();
      if (!doc) return empty;
      if (!pendingReplacement) return { ...empty, status: 'no-take', message: 'record a replacement first' };
      const before = doc.channels[0]?.length ?? 0;
      const result = await spliceAlignedWord({
        docId: doc.id,
        wordIndex,
        replacement: pendingReplacement.channels,
        replacementSampleRate: pendingReplacement.sampleRate,
        matchPitch: opts?.matchPitch,
      });
      if (!result.ok) return { ...empty, status: result.status, message: result.message };
      pendingReplacement = null;
      const after = activeDoc();
      const r = result.report;
      return {
        ok: true,
        status: 'ok',
        message: null,
        wordText: result.word.text,
        wordStart: result.word.startSample,
        wordEnd: result.word.endSample,
        regionStart: r.regionStart,
        regionEnd: r.regionEnd,
        trimmedSamples: r.trimmedSamples,
        stretchRatio: r.stretchRatio,
        gainDb: r.gainDb,
        pitchShiftSemitones: r.pitchShiftSemitones,
        headSeamSamples: r.headSeamSamples,
        tailSeamSamples: r.tailSeamSamples,
        lengthDelta: (after?.channels[0]?.length ?? 0) - before,
      };
    },

    setTranscriptSpeakers: (count) => {
      const doc = activeDoc();
      if (!doc) return null;
      const next = applyTranscriptSpeakerCount(doc.id, count);
      if (!next) return null;
      return {
        speakerCount: next.speakerCount,
        requestedSpeakerCount: next.requestedSpeakerCount,
        speakers: next.segments.map((s) => s.speaker),
      };
    },

    exportTranscriptTo: async (format, outPath) => {
      const doc = activeDoc();
      if (!doc) return false;
      const transcript = getTranscript(doc.id);
      if (!transcript || transcript.segments.length === 0) return false;
      const text =
        format === 'srt'
          ? formatSrt(transcript.segments, transcript.sampleRate)
          : formatWebVtt(transcript.segments, transcript.sampleRate);
      const bytes = new TextEncoder().encode(text);
      const buffer = new ArrayBuffer(bytes.byteLength);
      new Uint8Array(buffer).set(bytes);
      const result = await window.electronAPI.writeFile(outPath, buffer);
      return result.ok;
    },

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

    undoActive: () => {
      const doc = activeDoc();
      if (doc) undoHistoryUndo(doc.id);
      const after = activeDoc();
      return { length: after ? docLength(after) : 0 };
    },

    // F7. Drives runVocalChain for the active document, bypassing
    // VocalChainDialog — so the smoke exercises the real derivations, the real
    // worker leg and the ONE undo entry the chain is supposed to produce.
    runVocalChain: async (overrides) => {
      const before = activeDoc();
      const lengthBefore = before ? docLength(before) : 0;
      const zero = { rmsDb: 0, peakDb: 0, crestDb: 0, noiseFloorDb: null };
      if (!before) {
        return {
          ok: false,
          applied: false,
          undoDepth: 0,
          undoLabel: null,
          lengthBefore,
          lengthAfter: lengthBefore,
          before: zero,
          after: zero,
          stages: [],
          // The registry is knowable without a document, so the no-document
          // refusal reports it too — a caller comparing the report against the
          // stage list must not have to special-case this branch.
          registryStageIds: VOCAL_CHAIN_STAGES.map((s) => s.id),
          registryManualIds: VOCAL_CHAIN_STAGES.filter((s) => s.effectId === null).map((s) => s.id),
        };
      }
      const enabled = defaultStageSelection();
      for (const stage of VOCAL_CHAIN_STAGES) {
        const override = overrides?.[stage.id];
        if (typeof override === 'boolean') enabled[stage.id as VocalChainStageId] = override;
      }
      const depthBefore = getHistory(before.id).done.length;
      const report = await runVocalChain({ enabled });
      const after = activeDoc();
      const history = getHistory(before.id);
      return {
        ok: report !== null,
        applied: report?.applied === true,
        // The DELTA, so the assertion is "the chain added exactly one entry"
        // rather than "the history happens to be one deep".
        undoDepth: history.done.length - depthBefore,
        undoLabel: history.done.length > 0 ? history.done[history.done.length - 1] : null,
        lengthBefore,
        lengthAfter: after ? docLength(after) : 0,
        before: report ? report.before : zero,
        after: report ? report.after : zero,
        stages: (report?.stages ?? []).map((stage) => ({
          id: stage.id,
          status: stage.status,
          reason: stage.reason ?? null,
          derived: stage.derived.map((d) => ({ label: d.label, value: d.value })),
          detail: stage.detail ?? null,
          identicalFraction: stage.delta?.identicalFraction ?? null,
        })),
        // The registry's OWN ids and its OWN manual set, so a caller compares
        // the report against the stage list rather than against a hardcoded
        // number. That number rots the moment a stage is added, and it did:
        // F6's `lyrics` stage broke a smoke assertion reading `=== 11`, and
        // the `manual` assertion one line below it would have broken next.
        // Comparing lists also pins ORDER and MEMBERSHIP, which a count cannot.
        registryStageIds: VOCAL_CHAIN_STAGES.map((s) => s.id),
        registryManualIds: VOCAL_CHAIN_STAGES.filter((s) => s.effectId === null).map((s) => s.id),
      };
    },

    // F10. Drives runCoverChain for the active document, bypassing
    // CoverChainDialog — so the smoke exercises the real derivations, three
    // real DSP workers back to back, the ONE undo entry, and the promise the
    // unit suite structurally cannot check: that the reference document comes
    // back untouched after the real worker leg has transferred buffers.
    runCoverChain: async (referenceName, overrides) => {
      const zero: CoverMetricsJson = {
        gatedLevelDb: null,
        peakDb: 0,
        spreadDb: null,
        noiseFloorDb: null,
        matchDistanceDb: null,
      };
      const registry = {
        registryStageIds: COVER_CHAIN_STAGES.map((s) => s.id),
        registryManualIds: COVER_CHAIN_STAGES.filter((s) => s.effectId === null).map((s) => s.id),
      };
      const before = activeDoc();
      const lengthBefore = before ? docLength(before) : 0;
      if (!before) {
        return {
          ok: false,
          applied: false,
          undoDepth: 0,
          undoLabel: null,
          referenceName: null,
          referenceIntact: null,
          lengthBefore,
          lengthAfter: lengthBefore,
          before: zero,
          after: zero,
          reference: null,
          stages: [],
          ...registry,
        };
      }

      const refDoc =
        referenceName === null
          ? null
          : (useAppStore.getState().documents.find((d) => d.name === referenceName) ?? null);
      // Copied BEFORE the run, so "the reference is intact" is a comparison
      // against what it held rather than against itself.
      const refCopy = refDoc ? refDoc.channels.map((c) => Float32Array.from(c)) : null;

      const enabled = defaultCoverStageSelection();
      for (const stage of COVER_CHAIN_STAGES) {
        const override = overrides?.[stage.id];
        if (typeof override === 'boolean') enabled[stage.id as CoverChainStageId] = override;
      }
      const depthBefore = getHistory(before.id).done.length;
      const report = await runCoverChain({ enabled, referenceDocId: refDoc ? refDoc.id : null });
      const after = activeDoc();
      const history = getHistory(before.id);

      let referenceIntact: boolean | null = null;
      if (refCopy) {
        const now = useAppStore.getState().documents.find((d) => d.id === refDoc!.id) ?? null;
        referenceIntact =
          now !== null &&
          now.channels.length === refCopy.length &&
          now.channels.every(
            (c, i) => c.length === refCopy[i].length && refCopy[i].every((v, k) => v === c[k])
          );
      }

      return {
        ok: report !== null,
        applied: report?.applied === true,
        // The DELTA, so the assertion is "the chain added exactly one entry"
        // rather than "the history happens to be one deep".
        undoDepth: history.done.length - depthBefore,
        undoLabel: history.done.length > 0 ? history.done[history.done.length - 1] : null,
        referenceName: report?.referenceName ?? null,
        referenceIntact,
        lengthBefore,
        lengthAfter: after ? docLength(after) : 0,
        before: report ? report.before : zero,
        after: report ? report.after : zero,
        reference: report?.reference ?? null,
        stages: (report?.stages ?? []).map((stage) => ({
          id: stage.id,
          status: stage.status,
          reason: stage.reason ?? null,
          warning: stage.warning ?? null,
          derived: stage.derived.map((d) => ({ label: d.label, value: d.value })),
          detail: stage.detail ?? null,
          identicalFraction: stage.delta?.identicalFraction ?? null,
          // The peaks either side of THIS stage. Exposed because the packaged
          // step's Ruling C claim is about the peak the LIMITER was handed, and
          // the chain's own before/after cannot see it — every stage between
          // them has already run.
          peakBeforeDb: stage.delta?.peakBeforeDb ?? null,
          peakAfterDb: stage.delta?.peakAfterDb ?? null,
          eqBands: (stage.eq?.bands ?? []).map((b) => ({
            centreHz: b.centreHz,
            status: b.status,
            targetDb: b.targetDb,
            realisedDb: b.realisedDb,
            bandGainDb: b.bandGainDb,
            bounded: b.bounded,
          })),
          eqWorstErrorDb: stage.eq ? stage.eq.worstErrorDb : null,
        })),
        ...registry,
      };
    },

    // CP1. Drives the whole journey, bypassing CoverChainDialog.
    runCoverJourney: async (songName, takeName) => {
      const docs = useAppStore.getState().documents;
      const song = docs.find((d) => d.name === songName) ?? null;
      const take = docs.find((d) => d.name === takeName) ?? null;
      const empty = {
        ok: false,
        completed: false,
        cancelledAt: null,
        separationReused: null,
        alignmentOffsetSeconds: null,
        alignmentConfident: null,
        alignmentPeakCorrelation: null,
        alignmentProminence: null,
        alignmentRefused: false,
        alignmentAutoPlaced: false,
        sessionName: null,
        sessionTrackCount: 0,
        sessionRate: null,
        takeStartSample: null,
        instrumentalStartSample: null,
        shiftedSamples: null,
        fadeInSample: null,
        fadeOutSample: null,
        summedPeakDb: null,
        overCeiling: null,
        undoEntries: [] as string[],
        stages: [] as {
          id: string;
          status: string;
          reason: string | null;
          warning: string | null;
          derived: { label: string; value: string }[];
          nestedStageCount: number | null;
        }[],
        registryStageIds: COVER_JOURNEY_STAGES.map((s) => s.id),
      };
      if (!song || !take) return empty;

      const report = await runCoverJourney({ songDocId: song.id, takeDocId: take.id });
      if (!report) return empty;

      return {
        ok: true,
        completed: report.completed,
        cancelledAt: report.cancelledAt,
        separationReused: report.separation ? report.separation.reused : null,
        alignmentOffsetSeconds: report.alignment ? report.alignment.offsetSeconds : null,
        alignmentConfident: report.alignment ? report.alignment.confident : null,
        alignmentPeakCorrelation: report.alignment ? report.alignment.peakCorrelation : null,
        alignmentProminence: report.alignment ? report.alignment.prominence : null,
        alignmentRefused: report.alignmentRefused,
        alignmentAutoPlaced: report.alignmentAutoPlaced,
        sessionName: report.placement ? report.placement.sessionName : null,
        sessionTrackCount: useSessionStore.getState().session.tracks.length,
        sessionRate: report.placement ? report.placement.sessionRate : null,
        takeStartSample: report.placement ? report.placement.takeStartSample : null,
        instrumentalStartSample: report.placement ? report.placement.instrumentalStartSample : null,
        shiftedSamples: report.placement ? report.placement.shiftedSamples : null,
        fadeInSample: report.smoothing ? report.smoothing.fadeInSample : null,
        fadeOutSample: report.smoothing ? report.smoothing.fadeOutSample : null,
        summedPeakDb: report.smoothing ? report.smoothing.summedPeakDb : null,
        overCeiling: report.smoothing ? report.smoothing.overCeiling : null,
        undoEntries: report.undoEntries,
        stages: report.stages.map((stage) => ({
          id: stage.id,
          status: stage.status,
          reason: stage.reason ?? null,
          warning: stage.warning ?? null,
          derived: stage.derived.map((d) => ({ label: d.label, value: d.value })),
          nestedStageCount: stage.vocalChain
            ? stage.vocalChain.stages.length
            : stage.coverChain
              ? stage.coverChain.stages.length
              : null,
        })),
        registryStageIds: COVER_JOURNEY_STAGES.map((s) => s.id),
      };
    },

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
