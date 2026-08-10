/**
 * Renderer-side voice-changer service (F3) — the join between the
 * main-process inference host (`electron/voiceHost.cjs`, driven by
 * `electron/voiceManager.cjs`) and the UI. It owns the renderer half: the IPC
 * round trips, the resample discipline, the CONSENT GATE, the voice-profile
 * store, staleness, lifetime, busy accounting, and landing the converted
 * audio as a new document.
 *
 * This is `transcribeService.ts`'s shape, deliberately — the third feature on
 * the same proven pattern (stems v1.7, transcription v1.16). Where it
 * differs, the difference is stated with its reason.
 *
 * ## The pipeline
 *
 *   source document (native rate, any channel count)
 *     -> average to MONO at the document rate         [transcribeService.monoMix]
 *     -> resampleChannel(..., 22050)                  [the app's windowed-sinc]
 *     -> IPC 'voice:convert' -> utilityProcess -> OpenVoice V2 (ONNX, CPU EP)
 *     -> 'voice:chunk' events (finalized spliced regions, in order)
 *     -> ONE new 22050 Hz mono document
 *
 * 22050 Hz because that is the model's fixed rate (spike step 1), and the
 * result document STAYS at 22050 Hz: the converted audio is what the model
 * produced, and upsampling it back to the source rate would add no
 * information while doubling the memory of every later edit. This mirrors how
 * stem documents land at the stem model's 44100 rather than the source rate.
 *
 * ## THE CONSENT GATE (F3 RULING — blocking requirement)
 *
 * The spike measured this model good enough to impersonate a real person
 * (a 7.8 s public-figure clip converted to output scoring 0.831 against that
 * speaker — above the same-speaker threshold). The risk enters at the
 * reference clip, so the gate sits on the reference path: BOTH profile
 * creation (`createVoiceProfile`) and conversion (`convertDocumentVoice`)
 * refuse unless the caller passes `consentAffirmed: true` — the user's active
 * statement "I have the right to use this voice", never pre-checked, made in
 * the dialog. The main-process request parser enforces the same flag
 * independently (`voiceManager.cjs parseVoice*Request`), so removing this
 * gate alone cannot re-open the door. Both layers are pinned by tests that
 * fail if either gate is removed.
 *
 * ## Voice profiles
 *
 * A profile is a saved name + its 256-float tone embedding — reusable across
 * sessions, persisted by the MAIN process in `userData/voice-profiles.json`
 * (`voice:profiles-load` / `voice:profiles-save`; the renderer cannot write
 * arbitrary files, and `writePathPolicy.cjs` deliberately refuses `.json`).
 * Rows are sanitised on BOTH sides of the boundary; a malformed row is
 * dropped, never trusted.
 *
 * ## Lifetime
 *
 * One run at a time across BOTH kinds (embedding a reference and converting
 * share the manager's single utility-process slot). An in-flight conversion
 * aborts on a source edit or close (early store subscription + delivery-time
 * re-check, `peaksCache.ts` channel-identity convention). The returned
 * promises ALWAYS resolve — never reject, never hang.
 */

import { useSyncExternalStore } from 'react';
import type { AudioDocument } from '../audio/AudioDocument';
import { createDocument } from '../audio/AudioDocument';
import { useAppStore } from '../stores/appStore';
import { resampleChannel } from '../dsp/resample';
import { monoMix } from './transcribeService';

// ---------------------------------------------------------------------------
// Constants — mirrored from the main-process modules named in each comment.
// Duplicated rather than imported because the renderer must never load
// anything from `electron/` (CommonJS modules that pull in onnxruntime-node
// transitively) — the same rule transcribeService documents.
// ---------------------------------------------------------------------------

/** The model's fixed rate (`electron/voiceChunking.cjs` VC_SAMPLE_RATE). */
export const VC_SAMPLE_RATE = 22050;

/** Shortest representable input (`voiceChunking.cjs` MIN_INPUT_SAMPLES): the
 * 384-sample reflect pad needs 385 samples to read. ~17 ms at 22050. */
export const MIN_MODEL_SAMPLES = 385;

/** Conversion cap, 30 min at 22050 — MIRRORED from `voiceHost.cjs`
 * MAX_TOTAL_SAMPLES via the manager's parser; the two MUST agree or a job the
 * renderer accepts dies at the boundary with an opaque message. */
export const MAX_MODEL_SAMPLES = VC_SAMPLE_RATE * 1800;

/** Reference-clip cap, 350 s — `voiceHost.cjs` MAX_REFERENCE_SAMPLES (the
 * longest input the spike measured end-to-end; references are embedded
 * whole-utterance by the spike's round-2 requirement, so they cannot chunk). */
export const MAX_REFERENCE_MODEL_SAMPLES = VC_SAMPLE_RATE * 350;

/** `voiceHost.cjs` TONE_EMBEDDING_SIZE — the `[1, 256, 1]` tensor axis. */
export const TONE_EMBEDDING_SIZE = 256;

/** Chunk plan mirror (`voiceChunking.cjs` SEGMENT/STRIDE), used ONLY for the
 * time estimate below — the host owns the real plan. The renderer cannot
 * `require` the .cjs, so these are copies; voiceService.test.ts loads the real
 * module and asserts they are equal, which is what stops them drifting (they
 * already had, twice, before that pin existed). */
export const VC_SEGMENT_SAMPLES = 661504;
export const VC_STRIDE_SAMPLES = 627968;

/** Sum of the two `bytes` pins in `electron/voiceManager.cjs` VOICE_FILES —
 * 157,196,170 + 3,364,792. Fallback for the "no preload" model state only. */
export const VOICE_MODEL_BYTES = 160560962;

/**
 * Time-estimate seed: audio-seconds converted per wall-second.
 *
 * MEASURED, not chosen — the F3 spike's 11 s CPU run including the JS STFT
 * prep: 3.86x (model-only was 4.01x; longer inputs measured 4.79-4.89x, so
 * this is the conservative end of the measured band). Chunk overlap re-runs
 * SEGMENT/STRIDE of the audio, which {@link estimateConversionSeconds}
 * accounts for; the live estimate then re-derives from the run's own rate.
 */
export const MEASURED_REALTIME_FACTOR = 3.86;

/**
 * What the spike MEASURED the conversion to do, kept in code so the dialog
 * cannot drift into promising more (the DIARIZATION_LIMITS precedent). All
 * numbers from `.superpowers/sdd/task-F3-spike.md` round 2.
 */
export const VOICE_LIMITS = Object.freeze({
  /** The one miss: two low male voices 1.7 semitones apart barely moved. */
  missSemitones: 1.7,
  /** Worst intelligibility cost: 27% word errors at a +8.1 semitone jump. */
  worstWerPercent: 27,
  worstWerSemitones: 8.1,
});

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface VoiceModelState {
  downloaded: boolean;
  bytes: number | null;
  expectedBytes: number;
}

export interface VoiceProfile {
  id: string;
  name: string;
  /** The whole-utterance tone embedding — dest_tone, verbatim. */
  embedding: Float32Array;
  createdAt: number;
  /** Where the reference audio came from (file/document name), for the list. */
  sourceName: string;
}

export type VoiceRunPhase = 'resampling' | 'embedding' | 'converting';

export interface VoiceProgress {
  phase: VoiceRunPhase;
  /** Chunks done/total within the current host stage. */
  done: number;
  total: number;
  /** Whole-run fraction. The two host passes are weighted equally — a display
   * approximation (the spike measured only their combined rate), corrected
   * live by {@link estimatedRemainingMs} deriving from this run's own pace. */
  fraction: number;
  elapsedMs: number;
  estimatedRemainingMs: number | null;
}

export type VoiceStatus =
  | 'no-document'
  | 'empty-document'
  | 'consent-required'
  | 'no-profile'
  | 'bad-reference'
  | 'too-short'
  | 'too-long'
  | 'busy'
  | 'model-missing'
  | 'cancelled'
  | 'stale'
  | 'source-closed'
  | 'failed';

export type VoiceConvertResult =
  | { ok: true; docId: string; docName: string; sanitisedSamples: number }
  | { ok: false; status: VoiceStatus; message: string };

export type VoiceProfileResult =
  | { ok: true; profile: VoiceProfile; persistError: string | null }
  | { ok: false; status: VoiceStatus; message: string };

export interface ConvertVoiceRequest {
  docId: string;
  profileId: string;
  /** The consent affirmation — must be literally `true` (see module header). */
  consentAffirmed: boolean;
  onProgress?: (progress: VoiceProgress) => void;
}

export interface CreateVoiceProfileRequest {
  name: string;
  /** Reference audio at its native rate; this module mixes and resamples. */
  channels: readonly Float32Array[];
  sampleRate: number;
  sourceName: string;
  /** The consent affirmation — must be literally `true` (see module header). */
  consentAffirmed: boolean;
}

// ---------------------------------------------------------------------------
// The preload surface, read defensively (jsdom and older preloads lack it).
// ---------------------------------------------------------------------------

interface VoiceApi {
  voiceModelState?(): Promise<VoiceModelState>;
  voiceEnsureModels?(): Promise<{ ok: true } | { ok: false; error: string }>;
  onVoiceModelProgress?(
    cb: (p: { file: string; fileIndex: number; fileCount: number; received: number; total: number }) => void
  ): () => void;
  voiceEmbed?(req: {
    sampleRate: number;
    samples: ArrayBuffer;
    consent: boolean;
  }): Promise<{ ok: true; vector: ArrayBuffer } | { ok: false; cancelled?: true; error?: string }>;
  voiceConvert?(req: {
    sampleRate: number;
    samples: ArrayBuffer;
    target: ArrayBuffer;
    consent: boolean;
  }): Promise<
    { ok: true; chunkCount: number; sanitisedSamples: number } | { ok: false; cancelled?: true; error?: string }
  >;
  voiceCancel?(): Promise<{ cancelled: boolean }>;
  onVoiceProgress?(cb: (p: { stage: 'embed' | 'convert'; done: number; total: number }) => void): () => void;
  onVoiceChunk?(cb: (c: { offset: number; samples: number; data: ArrayBuffer }) => void): () => void;
  voiceProfilesLoad?(): Promise<{ ok: true; profiles: unknown[] } | { ok: false; error: string }>;
  voiceProfilesSave?(req: { profiles: unknown[] }): Promise<{ ok: true } | { ok: false; error: string }>;
  showMessageBox?(opts: {
    type?: 'info' | 'warning' | 'error' | 'question';
    title?: string;
    message: string;
  }): Promise<number>;
}

function api(): VoiceApi | undefined {
  return (window as unknown as { electronAPI?: VoiceApi }).electronAPI;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Terminal failures only — refusals, cancels and staleness aborts stay
 * inline in the dialog (the stemService/transcribeService one-liner). */
function showFailure(message: string): void {
  void api()?.showMessageBox?.({ type: 'error', title: 'Voice conversion failed', message });
}

// ---------------------------------------------------------------------------
// Reactivity — version counter + subscribe/getSnapshot (NOT zustand), the
// stemService/transcribeService shape.
// ---------------------------------------------------------------------------

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

/** Re-renders the caller whenever voice state (runs, profiles) changes. */
export function useVoiceVersion(): number {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function findDoc(docId: string): AudioDocument | undefined {
  return useAppStore.getState().documents.find((d) => d.id === docId);
}

/** `peaksCache.ts:16-22`'s identity-based "has the audio changed" test. */
function sameChannelRefs(a: readonly Float32Array[], b: readonly Float32Array[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/**
 * Wall-clock estimate for converting `modelSamples` of 22050 Hz audio. The
 * chunk overlap re-processes SEGMENT/STRIDE of the input (~1.053x for
 * multi-chunk runs, exactly 1x for a single chunk), and the measured factor
 * already includes both host passes over the audio they touch.
 */
export function estimateConversionSeconds(modelSamples: number): number {
  if (modelSamples <= 0) return 0;
  const chunks = Math.max(1, Math.ceil(modelSamples / VC_STRIDE_SAMPLES));
  let workSamples = 0;
  for (let i = 0; i < chunks; i++) {
    workSamples += Math.min(VC_SEGMENT_SAMPLES, modelSamples - i * VC_STRIDE_SAMPLES);
  }
  return workSamples / VC_SAMPLE_RATE / MEASURED_REALTIME_FACTOR;
}

/** Strips the final extension for result-document naming (fileService's
 * replace-the-extension idiom). */
function baseName(name: string): string {
  return name.replace(/\.[^.]+$/, '');
}

// ---------------------------------------------------------------------------
// Profile store
// ---------------------------------------------------------------------------

const profiles: VoiceProfile[] = [];
let profilesLoaded = false;
let profilesLoadError: string | null = null;
let nextProfileNumber = 1;

/** Renderer-side row sanitiser — the disk file crossed a process boundary
 * and a user-editable file, so it is validated AGAIN here (256 finite floats
 * or the row is dropped). */
function sanitizeProfileRow(raw: unknown): VoiceProfile | null {
  if (!raw || typeof raw !== 'object') return null;
  const row = raw as Record<string, unknown>;
  if (typeof row.id !== 'string' || row.id.length === 0 || row.id.length > 200) return null;
  if (typeof row.name !== 'string' || row.name.trim().length === 0 || row.name.length > 200) return null;
  if (!Array.isArray(row.embedding) || row.embedding.length !== TONE_EMBEDDING_SIZE) return null;
  const embedding = new Float32Array(TONE_EMBEDDING_SIZE);
  for (let i = 0; i < TONE_EMBEDDING_SIZE; i++) {
    const v = row.embedding[i];
    if (typeof v !== 'number' || !Number.isFinite(v)) return null;
    embedding[i] = v;
  }
  return {
    id: row.id,
    name: row.name.trim(),
    embedding,
    createdAt: typeof row.createdAt === 'number' && Number.isFinite(row.createdAt) ? row.createdAt : 0,
    sourceName: typeof row.sourceName === 'string' ? row.sourceName : '',
  };
}

/**
 * Loads the persisted profiles once per session (idempotent; re-entrant calls
 * await nothing extra). A missing bridge or failed load reads as an empty
 * library with the error recorded for the dialog to show.
 */
let profilesLoadPromise: Promise<void> | null = null;

export function ensureVoiceProfilesLoaded(): Promise<void> {
  if (profilesLoaded) return Promise.resolve();
  if (profilesLoadPromise) return profilesLoadPromise;
  profilesLoadPromise = (async () => {
    const bridge = api();
    if (!bridge?.voiceProfilesLoad) {
      profilesLoaded = true;
      return;
    }
    try {
      const result = await bridge.voiceProfilesLoad();
      if (result.ok) {
        for (const raw of result.profiles) {
          const clean = sanitizeProfileRow(raw);
          if (clean) profiles.push(clean);
        }
      } else {
        profilesLoadError = result.error;
      }
    } catch (err) {
      profilesLoadError = errorMessage(err);
    }
    // Sequential ids across sessions: continue after the highest voice-N.
    for (const p of profiles) {
      const m = /^voice-(\d+)$/.exec(p.id);
      if (m) nextProfileNumber = Math.max(nextProfileNumber, Number(m[1]) + 1);
    }
    profilesLoaded = true;
    bumpVersion();
  })();
  return profilesLoadPromise;
}

/** The loaded profiles (empty before {@link ensureVoiceProfilesLoaded}
 * settles). Non-reactive; pair with {@link useVoiceVersion}. */
export function getVoiceProfiles(): readonly VoiceProfile[] {
  return profiles;
}

/** The load failure, if any — the dialog renders it as an amber note. */
export function getVoiceProfilesLoadError(): string | null {
  return profilesLoadError;
}

async function persistProfiles(): Promise<string | null> {
  const bridge = api();
  if (!bridge?.voiceProfilesSave) return 'Voice profiles cannot be saved in this build.';
  try {
    const result = await bridge.voiceProfilesSave({
      profiles: profiles.map((p) => ({
        id: p.id,
        name: p.name,
        embedding: Array.from(p.embedding),
        createdAt: p.createdAt,
        sourceName: p.sourceName,
      })),
    });
    return result.ok ? null : result.error;
  } catch (err) {
    return errorMessage(err);
  }
}

/** Removes a profile and persists. The profile stays deleted in memory even
 * when persistence fails (the next successful save writes the truth). */
export async function deleteVoiceProfile(id: string): Promise<{ ok: boolean; persistError: string | null }> {
  const index = profiles.findIndex((p) => p.id === id);
  if (index < 0) return { ok: false, persistError: null };
  profiles.splice(index, 1);
  bumpVersion();
  return { ok: true, persistError: await persistProfiles() };
}

/** Test-only (`_xxxForTest` convention): resets every module singleton. */
export function _resetVoiceStateForTest(): void {
  profiles.length = 0;
  profilesLoaded = false;
  profilesLoadError = null;
  profilesLoadPromise = null;
  nextProfileNumber = 1;
  activeKind = null;
  activeRun = null;
  progressState = null;
  bumpVersion();
}

// ---------------------------------------------------------------------------
// Run state — ONE slot shared by embed and convert, like the manager's.
// ---------------------------------------------------------------------------

type AbortReason = 'user' | 'edited' | 'closed';

interface ActiveConvertRun {
  id: number;
  docId: string;
  channelRefs: Float32Array[];
  docLength: number;
  modelLength: number;
  /** The assembled output; chunks land in order at `received`. */
  output: Float32Array;
  received: number;
  /** Set when a chunk event violates the contiguous-tiling contract. */
  protocolViolation: string | null;
  abortReason: AbortReason | null;
  cancelInvoked: boolean;
  settled: boolean;
  startedAt: number;
}

let activeKind: 'embed' | 'convert' | null = null;
let activeRun: ActiveConvertRun | null = null;
let nextRunId = 1;
let progressState: VoiceProgress | null = null;
let staleWatchEnabled = true;

/** Test-only twin of `transcribeService._setStaleWatchForTest` — lets the
 * delivery-time staleness gate be exercised without the early subscription
 * always winning the race. */
export function _setVoiceStaleWatchForTest(enabled: boolean): void {
  staleWatchEnabled = enabled;
}

export function isVoiceRunning(): boolean {
  return activeKind !== null;
}

/** Close-guard contribution (App.tsx adds it to the in-flight sum): quitting
 * mid-conversion must WARN, not silently discard minutes of inference. */
export function getVoiceBusyCount(): number {
  return activeKind !== null ? 1 : 0;
}

export function getVoiceProgress(): VoiceProgress | null {
  return progressState;
}

function publishProgress(
  run: ActiveConvertRun,
  next: Omit<VoiceProgress, 'elapsedMs'>,
  onProgress?: (p: VoiceProgress) => void
): void {
  if (activeRun !== run) return;
  const progress: VoiceProgress = { ...next, elapsedMs: Date.now() - run.startedAt };
  progressState = progress;
  bumpVersion();
  onProgress?.(progress);
}

/** The single abort point (transcribeService's shape): records WHY and asks
 * the manager to kill the child exactly once; the in-flight invoke then
 * settles through its normal path — exactly one settlement site. */
function abortRun(run: ActiveConvertRun, reason: AbortReason): void {
  if (run.settled || run.abortReason) return;
  run.abortReason = reason;
  if (!run.cancelInvoked) {
    run.cancelInvoked = true;
    const bridge = api();
    if (bridge?.voiceCancel) {
      void bridge.voiceCancel().catch(() => {
        /* the run settles from the invoke's own resolution regardless */
      });
    }
  }
}

/** Cancels the in-flight run (conversion OR reference embedding). */
export async function cancelVoiceRun(): Promise<boolean> {
  if (activeRun) {
    abortRun(activeRun, 'user');
    return true;
  }
  if (activeKind === 'embed') {
    const bridge = api();
    if (bridge?.voiceCancel) {
      try {
        await bridge.voiceCancel();
      } catch {
        /* nothing to do — the embed invoke settles on its own */
      }
    }
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Model state
// ---------------------------------------------------------------------------

export async function getVoiceModelState(): Promise<VoiceModelState> {
  const bridge = api();
  if (!bridge?.voiceModelState) {
    return { downloaded: false, bytes: null, expectedBytes: VOICE_MODEL_BYTES };
  }
  try {
    return await bridge.voiceModelState();
  } catch {
    return { downloaded: false, bytes: null, expectedBytes: VOICE_MODEL_BYTES };
  }
}

export async function ensureVoiceModels(
  onProgress?: (p: { file: string; fileIndex: number; fileCount: number; received: number; total: number }) => void
): Promise<{ ok: true } | { ok: false; error: string }> {
  const bridge = api();
  if (!bridge?.voiceEnsureModels) {
    return { ok: false, error: 'The voice changer is unavailable in this build.' };
  }
  const unsubscribe =
    onProgress && bridge.onVoiceModelProgress ? bridge.onVoiceModelProgress(onProgress) : null;
  try {
    return await bridge.voiceEnsureModels();
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  } finally {
    unsubscribe?.();
  }
}

// ---------------------------------------------------------------------------
// Profile creation — the reference-clip path, consent-gated
// ---------------------------------------------------------------------------

function failProfile(status: VoiceStatus, message: string): VoiceProfileResult {
  return { ok: false, status, message };
}

/**
 * Embeds a reference clip and saves it as a profile. CONSENT GATE FIRST: the
 * request is refused before any audio is touched — and before any IPC — when
 * `consentAffirmed` is not literally `true`.
 */
export async function createVoiceProfile(req: CreateVoiceProfileRequest): Promise<VoiceProfileResult> {
  if (req.consentAffirmed !== true) {
    return failProfile(
      'consent-required',
      'Affirm that you have the right to use this voice before saving it.'
    );
  }
  const bridge = api();
  if (!bridge?.voiceEmbed) {
    return failProfile('failed', 'The voice changer is unavailable in this build.');
  }
  if (activeKind !== null) return failProfile('busy', 'A voice operation is already running.');

  const name = req.name.trim();
  if (name.length === 0 || name.length > 200) {
    return failProfile('bad-reference', 'Give the voice a name (up to 200 characters).');
  }
  const length = req.channels[0]?.length ?? 0;
  if (req.channels.length === 0 || length === 0) {
    return failProfile('bad-reference', 'The reference clip has no audio.');
  }

  await ensureVoiceProfilesLoaded();
  if (activeKind !== null) return failProfile('busy', 'A voice operation is already running.');
  activeKind = 'embed';
  bumpVersion();
  try {
    const modelState = await getVoiceModelState();
    if (!modelState.downloaded) {
      return failProfile(
        'model-missing',
        'The voice model has not been downloaded yet (about 161 MB, one time).'
      );
    }

    let outgoing: Float32Array;
    try {
      const mono = monoMix(req.channels, length);
      outgoing = resampleChannel(mono, req.sampleRate, VC_SAMPLE_RATE);
    } catch (err) {
      return failProfile('failed', errorMessage(err));
    }
    if (outgoing.length < MIN_MODEL_SAMPLES) {
      return failProfile('bad-reference', 'The reference clip is too short — use at least a moment of speech.');
    }
    if (outgoing.length > MAX_REFERENCE_MODEL_SAMPLES) {
      return failProfile(
        'bad-reference',
        'Reference clips are limited to 350 seconds — a few seconds of clean speech is enough.'
      );
    }

    let result: Awaited<ReturnType<NonNullable<VoiceApi['voiceEmbed']>>>;
    try {
      result = await bridge.voiceEmbed({
        sampleRate: VC_SAMPLE_RATE,
        samples: outgoing.buffer as ArrayBuffer,
        consent: true,
      });
    } catch (err) {
      return failProfile('failed', errorMessage(err));
    }
    if (!result.ok) {
      if (result.cancelled) return failProfile('cancelled', 'Saving the voice was cancelled.');
      return failProfile('failed', result.error ?? 'The voice host failed.');
    }

    const vector = new Float32Array(result.vector);
    if (vector.length !== TONE_EMBEDDING_SIZE) {
      return failProfile('failed', `The voice host returned a ${vector.length}-value embedding (expected 256).`);
    }
    for (let i = 0; i < vector.length; i++) {
      if (!Number.isFinite(vector[i])) {
        return failProfile('failed', 'The voice host returned a non-finite embedding.');
      }
    }

    const profile: VoiceProfile = {
      id: `voice-${nextProfileNumber++}`,
      name,
      embedding: vector,
      createdAt: Date.now(),
      sourceName: req.sourceName,
    };
    profiles.push(profile);
    bumpVersion();
    const persistError = await persistProfiles();
    return { ok: true, profile, persistError };
  } finally {
    activeKind = null;
    bumpVersion();
  }
}

// ---------------------------------------------------------------------------
// Conversion
// ---------------------------------------------------------------------------

function fail(status: VoiceStatus, message: string): VoiceConvertResult {
  return { ok: false, status, message };
}

function statusForAbort(reason: AbortReason | null): VoiceStatus {
  if (reason === 'edited') return 'stale';
  if (reason === 'closed') return 'source-closed';
  return 'cancelled';
}

function messageForAbort(reason: AbortReason | null): string {
  if (reason === 'edited') return 'The audio changed during conversion — the result was discarded.';
  if (reason === 'closed') return 'The document was closed during conversion.';
  return 'The conversion was cancelled.';
}

/**
 * Converts `docId` to the profile's voice and lands the result as a NEW
 * 22050 Hz mono document (the remixService landing shape). ALWAYS resolves.
 * CONSENT GATE FIRST — see the module header.
 */
export async function convertDocumentVoice(req: ConvertVoiceRequest): Promise<VoiceConvertResult> {
  if (req.consentAffirmed !== true) {
    return fail(
      'consent-required',
      'Affirm that you have the right to use this voice before converting.'
    );
  }
  const bridge = api();
  if (!bridge?.voiceConvert || !bridge.onVoiceProgress || !bridge.onVoiceChunk) {
    return fail('failed', 'The voice changer is unavailable in this build.');
  }
  // Synchronous up to the `activeKind` assignment — two same-tick calls can
  // never both pass the busy gate (the managers' reservation discipline).
  if (activeKind !== null) return fail('busy', 'A voice operation is already running.');

  const doc = findDoc(req.docId);
  if (!doc) return fail('no-document', `Document ${req.docId} is not open.`);
  const docLength = doc.channels[0]?.length ?? 0;
  if (docLength === 0) return fail('empty-document', `${doc.name} has no audio to convert.`);

  const estimatedModelLength = Math.round(docLength * (VC_SAMPLE_RATE / doc.sampleRate));
  if (estimatedModelLength > MAX_MODEL_SAMPLES) {
    return fail('too-long', 'Voice conversion is limited to 30 minutes of audio in one run.');
  }
  if (estimatedModelLength < MIN_MODEL_SAMPLES) {
    return fail('too-short', `${doc.name} is too short to convert (under ~20 ms).`);
  }

  const profile = profiles.find((p) => p.id === req.profileId);
  if (!profile) return fail('no-profile', 'Choose a voice to convert to.');

  const run: ActiveConvertRun = {
    id: nextRunId++,
    docId: doc.id,
    channelRefs: doc.channels.slice(),
    docLength,
    modelLength: estimatedModelLength,
    output: new Float32Array(0),
    received: 0,
    protocolViolation: null,
    abortReason: null,
    cancelInvoked: false,
    settled: false,
    startedAt: Date.now(),
  };
  activeKind = 'convert';
  activeRun = run;
  const docName = doc.name;
  const seedEstimateMs = estimateConversionSeconds(estimatedModelLength) * 1000;

  // EARLY abort on edit/close (the delivery-time re-check is the guarantee;
  // this saves the CPU).
  const unsubscribeStore = useAppStore.subscribe(() => {
    if (!staleWatchEnabled || activeRun !== run || run.settled) return;
    const live = findDoc(run.docId);
    if (!live) abortRun(run, 'closed');
    else if (!sameChannelRefs(run.channelRefs, live.channels)) abortRun(run, 'edited');
  });

  const unsubscribers: (() => void)[] = [];

  try {
    const modelState = await getVoiceModelState();
    if (run.abortReason) return fail(statusForAbort(run.abortReason), messageForAbort(run.abortReason));
    if (!modelState.downloaded) {
      return fail('model-missing', 'The voice model has not been downloaded yet (about 161 MB, one time).');
    }

    publishProgress(
      run,
      { phase: 'resampling', done: 0, total: 0, fraction: 0, estimatedRemainingMs: seedEstimateMs },
      req.onProgress
    );

    let outgoing: Float32Array;
    try {
      const mono = monoMix(doc.channels, docLength);
      outgoing = resampleChannel(mono, doc.sampleRate, VC_SAMPLE_RATE);
    } catch (err) {
      // A multi-hundred-MB allocation failing under memory pressure is a
      // NORMAL failure here, not an escape.
      showFailure(errorMessage(err));
      return fail('failed', errorMessage(err));
    }
    if (run.abortReason) return fail(statusForAbort(run.abortReason), messageForAbort(run.abortReason));

    // The resampler rounds independently of the estimate above; its real
    // length is what the host is told and what the chunks tile.
    run.modelLength = outgoing.length;
    if (run.modelLength < MIN_MODEL_SAMPLES) {
      return fail('too-short', `${docName} is too short to convert (under ~20 ms).`);
    }
    run.output = new Float32Array(run.modelLength);

    unsubscribers.push(
      bridge.onVoiceProgress((p) => {
        if (activeRun !== run || run.settled) return;
        const total = Number.isFinite(p.total) && p.total > 0 ? p.total : 0;
        const done = Number.isFinite(p.done) && p.done > 0 ? p.done : 0;
        const stageFraction = total > 0 ? Math.min(1, done / total) : 0;
        // Two equally-weighted passes (display approximation, see the type).
        const fraction = p.stage === 'embed' ? stageFraction / 2 : 0.5 + stageFraction / 2;
        const elapsed = Date.now() - run.startedAt;
        const remaining =
          fraction > 0 ? (elapsed / fraction) * (1 - fraction) : seedEstimateMs;
        publishProgress(
          run,
          {
            phase: p.stage === 'embed' ? 'embedding' : 'converting',
            done,
            total,
            fraction,
            estimatedRemainingMs: remaining,
          },
          req.onProgress
        );
      })
    );

    unsubscribers.push(
      bridge.onVoiceChunk((c) => {
        if (activeRun !== run || run.settled || run.protocolViolation) return;
        const data = c.data;
        if (
          !Number.isInteger(c.offset) ||
          !Number.isInteger(c.samples) ||
          c.samples <= 0 ||
          c.offset !== run.received ||
          c.offset + c.samples > run.modelLength ||
          !(Object.prototype.toString.call(data) === '[object ArrayBuffer]') ||
          data.byteLength !== c.samples * 4
        ) {
          // The host streams contiguous regions in order; anything else means
          // the output would be silently wrong. Record it — the final gate
          // turns it into an honest failure.
          run.protocolViolation = `malformed chunk at offset ${String(c.offset)}`;
          return;
        }
        run.output.set(new Float32Array(data), c.offset);
        run.received += c.samples;
      })
    );

    publishProgress(
      run,
      { phase: 'embedding', done: 0, total: 0, fraction: 0, estimatedRemainingMs: seedEstimateMs },
      req.onProgress
    );

    let result: Awaited<ReturnType<NonNullable<VoiceApi['voiceConvert']>>>;
    try {
      result = await bridge.voiceConvert({
        sampleRate: VC_SAMPLE_RATE,
        samples: outgoing.buffer as ArrayBuffer,
        target: profile.embedding.buffer.slice(
          profile.embedding.byteOffset,
          profile.embedding.byteOffset + profile.embedding.byteLength
        ) as ArrayBuffer,
        consent: true,
      });
    } catch (err) {
      // A rejected invoke means the IPC channel died — but the manager may
      // still own a live child. Kill it explicitly (transcribeService's
      // reasoning verbatim); keep the `failed` status, not `cancelled`.
      if (!run.cancelInvoked) {
        run.cancelInvoked = true;
        void bridge.voiceCancel?.().catch(() => {
          /* best-effort on a dead channel */
        });
      }
      const message = errorMessage(err);
      showFailure(message);
      return fail('failed', message);
    } finally {
      outgoing = new Float32Array(0); // the 22 kHz copy is IPC-copied by now
    }

    if (run.abortReason) return fail(statusForAbort(run.abortReason), messageForAbort(run.abortReason));

    if (!result.ok) {
      if (result.cancelled) {
        return fail(statusForAbort(run.abortReason), messageForAbort(run.abortReason));
      }
      const message = result.error ?? 'The voice host failed.';
      showFailure(message);
      return fail('failed', message);
    }

    if (run.protocolViolation) {
      const message = `The voice host misdelivered audio (${run.protocolViolation}).`;
      showFailure(message);
      return fail('failed', message);
    }
    // Completeness gate — the chunks must tile the whole output, or the
    // document would be silently truncated.
    if (run.received !== run.modelLength) {
      const message = `The voice host delivered ${run.received} of ${run.modelLength} samples.`;
      showFailure(message);
      return fail('failed', message);
    }

    // DELIVERY-TIME staleness re-check: never land audio converted from a
    // document that has since changed or closed.
    const live = findDoc(run.docId);
    if (!live) return fail('source-closed', messageForAbort('closed'));
    if (!sameChannelRefs(run.channelRefs, live.channels)) return fail('stale', messageForAbort('edited'));

    // Land as a NEW document — the remixService shape: createDocument,
    // addDocument (activates + resets selection/cursor/zoom), waveform view.
    const newDoc = createDocument({
      name: `${baseName(docName)} — ${profile.name} voice`,
      sampleRate: VC_SAMPLE_RATE,
      channels: [run.output],
    });
    const store = useAppStore.getState();
    store.addDocument(newDoc);
    store.setView('waveform');

    return { ok: true, docId: newDoc.id, docName: newDoc.name, sanitisedSamples: result.sanitisedSamples };
  } catch (err) {
    const message = errorMessage(err);
    showFailure(message);
    return fail('failed', message);
  } finally {
    run.settled = true;
    for (const off of unsubscribers) off();
    unsubscribeStore();
    run.output = new Float32Array(0);
    if (activeRun === run) {
      activeRun = null;
      activeKind = null;
      progressState = null;
    }
    bumpVersion();
  }
}
