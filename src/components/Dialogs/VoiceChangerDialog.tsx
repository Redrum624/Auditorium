import { useEffect, useRef, useState } from 'react';
import { AudioLines, FileAudio, Speech, Trash2 } from 'lucide-react';
import { docLength } from '../../audio/AudioDocument';
import { decodeArrayBuffer } from '../../audio/decodeAudio';
import { useAppStore } from '../../stores/appStore';
import {
  MEASURED_REALTIME_FACTOR,
  VC_SAMPLE_RATE,
  VOICE_LIMITS,
  cancelVoiceRun,
  convertDocumentVoice,
  createVoiceProfile,
  deleteVoiceProfile,
  ensureVoiceModels,
  ensureVoiceProfilesLoaded,
  estimateConversionSeconds,
  getVoiceModelState,
  getVoiceProfiles,
  getVoiceProfilesLoadError,
  useVoiceVersion,
  type VoiceModelState,
  type VoiceProgress,
} from '../../services/voiceService';
import { GlassButton, GlassField, SectionLabel } from '../UI/glass';
import DialogShell from './DialogShell';

/** Audio extensions offered for the reference-clip picker — fileService's own
 * Open-dialog filter, restated (that module keeps it private). */
const AUDIO_EXTENSIONS = ['wav', 'mp3', 'ogg', 'flac', 'm4a', 'aac', 'webm'];

/** `m:ss` (SeparateDialog's grain — seconds are finer than the estimate). */
function formatMmss(samples: number, sampleRate: number): string {
  const total = Number.isFinite(samples) ? Math.max(0, Math.round(samples / sampleRate)) : 0;
  const minutes = Math.floor(total / 60);
  return `${minutes}:${String(total - minutes * 60).padStart(2, '0')}`;
}

function formatSeconds(seconds: number): string {
  return formatMmss(Math.max(0, Math.round(seconds)), 1);
}

function formatMb(bytes: number): string {
  return `${Math.round(bytes / 1e6)} MB`;
}

function stripExtension(name: string): string {
  return name.replace(/\.[^.]+$/, '');
}

interface PendingReference {
  /** What the list shows while naming ("clip.wav", "Take 7 (selection)"). */
  sourceName: string;
  channels: Float32Array[];
  sampleRate: number;
}

/**
 * F3 — the Voice Changer dialog. SeparateDialog's four-state shape (model
 * missing / ready / running / result) plus the two things this feature adds:
 *
 * 1. **Voice profiles** — the reusable target voices. A reference clip comes
 *    from an audio file or from the current selection, gets a name, and is
 *    embedded once; the saved profile is a name + 256-float tone embedding,
 *    persisted across sessions.
 * 2. **THE CONSENT AFFIRMATION (blocking, by ruling).** Choosing a reference
 *    clip or converting requires the user's own active statement — the
 *    checkbox below is NEVER pre-checked, resets whenever the chosen voice
 *    changes, and both Save Voice and Convert stay disabled without it. The
 *    service and the main process each refuse independently, so this checkbox
 *    is the surface of the gate, not its only enforcement.
 *
 * Honest-limits text comes from VOICE_LIMITS (spike round 2) so the dialog
 * cannot promise more than was measured.
 */
export default function VoiceChangerDialog({ onClose }: { onClose: () => void }) {
  useVoiceVersion();
  const doc = useAppStore((s) => s.documents.find((d) => d.id === s.activeDocumentId) ?? null);
  const selection = useAppStore((s) => s.selection);
  const length = doc ? docLength(doc) : 0;

  const [model, setModel] = useState<VoiceModelState | null>(null);
  const [downloading, setDownloading] = useState(false);
  const [received, setReceived] = useState(0);
  const [running, setRunning] = useState(false);
  const [saving, setSaving] = useState(false);
  const [progress, setProgress] = useState<VoiceProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [selectedProfileId, setSelectedProfileId] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingReference | null>(null);
  const [pendingName, setPendingName] = useState('');
  // NEVER default this to true, and never remove the reset effect below —
  // the pair is what keeps the affirmation un-pre-checked (the F3 ruling).
  const [consent, setConsent] = useState(false);

  const busy = downloading || running || saving;
  const profiles = getVoiceProfiles();

  const unmountedRef = useRef(false);
  const runningRef = useRef(false);

  useEffect(() => {
    unmountedRef.current = false;
    return () => {
      unmountedRef.current = true;
      if (runningRef.current) {
        runningRef.current = false;
        // An orphaned conversion would hold the close guard up and keep a
        // CPU-inference utility process alive for audio nobody can receive.
        void cancelVoiceRun();
      }
    };
  }, []);

  useEffect(() => {
    void ensureVoiceProfilesLoaded();
    void (async () => {
      const state = await getVoiceModelState();
      if (!unmountedRef.current) setModel(state);
    })();
  }, []);

  // THE RULING'S RESET: the affirmation is about THIS voice. Any change of
  // the chosen voice — a different profile, a new reference clip — clears it,
  // so a consent given once can never silently cover a different speaker.
  useEffect(() => {
    setConsent(false);
  }, [selectedProfileId, pending]);

  function liveDoc() {
    const state = useAppStore.getState();
    return state.documents.find((d) => d.id === state.activeDocumentId) ?? null;
  }

  async function handleDownload(): Promise<void> {
    setDownloading(true);
    setError(null);
    setReceived(0);
    let result: Awaited<ReturnType<typeof ensureVoiceModels>>;
    try {
      result = await ensureVoiceModels((p) => {
        if (!unmountedRef.current) setReceived(p.received);
      });
    } finally {
      if (!unmountedRef.current) setDownloading(false);
    }
    if (unmountedRef.current) return;
    if (!result.ok) {
      setError(result.error);
      return;
    }
    const state = await getVoiceModelState();
    if (!unmountedRef.current) setModel(state);
  }

  async function handleAddFromFile(): Promise<void> {
    const bridge = window.electronAPI;
    if (!bridge?.showOpenDialog || !bridge.readFile) {
      setError('Opening files is unavailable in this build.');
      return;
    }
    setError(null);
    const paths = await bridge.showOpenDialog({
      multi: false,
      filters: [{ name: 'Audio', extensions: AUDIO_EXTENSIONS }],
    });
    if (unmountedRef.current || !paths || paths.length === 0) return;
    try {
      const buf = await bridge.readFile(paths[0]);
      const decoded = await decodeArrayBuffer(buf, paths[0]);
      if (unmountedRef.current) return;
      const name = bridge.pathBasename(paths[0]);
      setPending({ sourceName: name, channels: decoded.channels, sampleRate: decoded.sampleRate });
      setPendingName(stripExtension(name));
    } catch (err) {
      if (!unmountedRef.current) setError(err instanceof Error ? err.message : String(err));
    }
  }

  function handleAddFromSelection(): void {
    const live = liveDoc();
    const sel = useAppStore.getState().selection;
    if (!live || !sel || sel.end <= sel.start) {
      setError('Select part of the document to use as the reference voice.');
      return;
    }
    setError(null);
    setPending({
      sourceName: `${live.name} (selection)`,
      channels: live.channels.map((ch) => ch.slice(sel.start, sel.end)),
      sampleRate: live.sampleRate,
    });
    setPendingName(`${stripExtension(live.name)} voice`);
  }

  async function handleSaveVoice(): Promise<void> {
    if (!pending) return;
    setSaving(true);
    setError(null);
    let result: Awaited<ReturnType<typeof createVoiceProfile>>;
    try {
      result = await createVoiceProfile({
        name: pendingName,
        channels: pending.channels,
        sampleRate: pending.sampleRate,
        sourceName: pending.sourceName,
        consentAffirmed: consent,
      });
    } finally {
      if (!unmountedRef.current) setSaving(false);
    }
    if (unmountedRef.current) return;
    if (!result.ok) {
      setError(result.message);
      if (result.status === 'model-missing') {
        setModel({ downloaded: false, bytes: null, expectedBytes: model?.expectedBytes ?? 0 });
      }
      return;
    }
    setPending(null);
    setPendingName('');
    setSelectedProfileId(result.profile.id);
    if (result.persistError) {
      setNote(`The voice was saved for this session, but writing the profile file failed: ${result.persistError}`);
    }
  }

  async function handleConvert(): Promise<void> {
    const live = liveDoc();
    if (!live) {
      setError('No document is open.');
      return;
    }
    if (!selectedProfileId) {
      setError('Choose a voice to convert to.');
      return;
    }
    setRunning(true);
    runningRef.current = true;
    setProgress(null);
    setError(null);
    setNote(null);
    let result: Awaited<ReturnType<typeof convertDocumentVoice>>;
    try {
      result = await convertDocumentVoice({
        docId: live.id,
        profileId: selectedProfileId,
        consentAffirmed: consent,
        onProgress: (p) => {
          if (!unmountedRef.current) setProgress(p);
        },
      });
    } finally {
      runningRef.current = false;
      if (!unmountedRef.current) setRunning(false);
    }
    if (unmountedRef.current) return;
    if (!result.ok) {
      setError(result.message);
      if (result.status === 'model-missing') {
        setModel({ downloaded: false, bytes: null, expectedBytes: model?.expectedBytes ?? 0 });
      }
      return;
    }
    if (result.sanitisedSamples > 0) {
      setNote(
        `Done — ${result.docName} was created. The model returned ${result.sanitisedSamples} non-finite sample(s), which were zeroed.`
      );
      return;
    }
    onClose();
  }

  const expectedBytes = model?.expectedBytes ?? 0;
  const modelMissing = model !== null && !model.downloaded;
  const canConvert =
    !busy &&
    doc !== null &&
    length > 0 &&
    model?.downloaded === true &&
    selectedProfileId !== null &&
    consent;
  const canSaveVoice = !busy && pending !== null && pendingName.trim().length > 0 && consent;
  const profilesLoadError = getVoiceProfilesLoadError();
  const message = error ?? (doc === null ? 'No document is open.' : null);
  const modelSamples = doc ? Math.round(length * (VC_SAMPLE_RATE / doc.sampleRate)) : 0;
  const estimateSec = estimateConversionSeconds(modelSamples);
  const remaining = progress?.estimatedRemainingMs ?? null;
  const hasSelection = doc !== null && selection !== null && selection.end > selection.start;

  return (
    <DialogShell
      title="Voice Changer"
      subtitle={doc ? `${doc.name} · ${formatMmss(length, doc.sampleRate)}` : undefined}
      icon={<Speech size={15} />}
      width={520}
      onClose={onClose}
      dismissable={!busy}
    >
      <div className="flex flex-col gap-3" data-testid="voice-dialog">
        <p data-testid="voice-produces" className="text-xs" style={{ color: 'var(--glass-text-label)' }}>
          Re-voices this document so it sounds like the chosen speaker, keeping the words and the
          delivery. The result lands as a new 22 kHz mono document.
        </p>
        <p data-testid="voice-limits" className="text-xs" style={{ color: 'var(--glass-text-secondary)' }}>
          {`It is a voice change, not a forensic-grade clone — expect "clearly in the target's direction", strongest when the voices differ. A target close to the source barely moves (the one measured miss was two voices ${VOICE_LIMITS.missSemitones} semitones apart), and very large pitch moves can blur words (up to ${VOICE_LIMITS.worstWerPercent}% at +${VOICE_LIMITS.worstWerSemitones} semitones).`}
        </p>

        {modelMissing && (
          <div data-testid="voice-model-missing" className="flex flex-col gap-2">
            <SectionLabel>Model</SectionLabel>
            <p className="text-xs" style={{ color: 'var(--glass-text-label)' }}>
              {`Voice conversion needs the OpenVoice model — a ${formatMb(
                expectedBytes
              )} one-time download, kept with the app's settings and reused for every later conversion.`}
            </p>
            {downloading ? (
              <div>
                <p
                  data-testid="voice-download-status"
                  className="mb-1 text-xs"
                  style={{ color: 'var(--glass-text-muted)' }}
                >
                  {`Downloading… ${formatMb(received)} of ${formatMb(expectedBytes)}`}
                </p>
                <ProgressTrack
                  testId="voice-download-progress"
                  fraction={expectedBytes > 0 ? received / expectedBytes : 0}
                />
              </div>
            ) : (
              <div>
                <GlassButton variant="primary" onClick={() => void handleDownload()}>
                  Download Model
                </GlassButton>
              </div>
            )}
          </div>
        )}

        <SectionLabel>Target voice</SectionLabel>

        {profilesLoadError && (
          <p className="text-xs text-[#e0a458]">{`Saved voices could not be loaded: ${profilesLoadError}`}</p>
        )}

        {profiles.length > 0 && (
          <div data-testid="voice-profile-list" className="flex flex-col gap-1">
            {profiles.map((p) => (
              <div key={p.id} className="flex items-center gap-2">
                <button
                  type="button"
                  data-testid={`voice-profile-${p.id}`}
                  aria-pressed={selectedProfileId === p.id}
                  disabled={busy}
                  onClick={() => setSelectedProfileId(selectedProfileId === p.id ? null : p.id)}
                  className="flex-1 rounded px-2 py-1 text-left text-xs"
                  style={{
                    background:
                      selectedProfileId === p.id ? 'rgba(38, 198, 218, 0.18)' : 'rgba(255, 255, 255, 0.05)',
                    color: 'var(--glass-text-label)',
                    outline: selectedProfileId === p.id ? '1px solid var(--accent)' : 'none',
                  }}
                >
                  <span className="font-medium">{p.name}</span>
                  {p.sourceName && (
                    <span style={{ color: 'var(--glass-text-muted)' }}>{` · ${p.sourceName}`}</span>
                  )}
                </button>
                <button
                  type="button"
                  data-testid={`voice-delete-${p.id}`}
                  aria-label={`Delete ${p.name}`}
                  disabled={busy}
                  onClick={() => {
                    if (selectedProfileId === p.id) setSelectedProfileId(null);
                    void deleteVoiceProfile(p.id);
                  }}
                  className="rounded p-1"
                  style={{ color: 'var(--glass-text-muted)' }}
                >
                  <Trash2 size={13} />
                </button>
              </div>
            ))}
          </div>
        )}

        {profiles.length === 0 && !pending && (
          <p className="text-xs" style={{ color: 'var(--glass-text-muted)' }}>
            No saved voices yet — add one from an audio file or from the current selection.
          </p>
        )}

        {!pending && (
          <div className="flex gap-2">
            <GlassButton data-testid="voice-add-file" disabled={busy} onClick={() => void handleAddFromFile()}>
              <FileAudio size={13} className="mr-1 inline" />
              New voice from file…
            </GlassButton>
            <GlassButton
              data-testid="voice-add-selection"
              disabled={busy || !hasSelection}
              onClick={() => handleAddFromSelection()}
            >
              <AudioLines size={13} className="mr-1 inline" />
              New voice from selection
            </GlassButton>
          </div>
        )}

        {pending && (
          <div data-testid="voice-pending" className="flex flex-col gap-2">
            <p className="text-xs" style={{ color: 'var(--glass-text-label)' }}>
              {`Reference: ${pending.sourceName} · ${formatMmss(
                pending.channels[0]?.length ?? 0,
                pending.sampleRate
              )} — a few seconds of clean, single-speaker speech works best.`}
            </p>
            <GlassField
              data-testid="voice-name"
              type="text"
              value={pendingName}
              placeholder="Voice name"
              disabled={busy}
              onChange={(e) => setPendingName(e.target.value)}
            />
            <div className="flex gap-2">
              <GlassButton data-testid="voice-save" variant="primary" disabled={!canSaveVoice} onClick={() => void handleSaveVoice()}>
                {saving ? 'Saving voice…' : 'Save Voice'}
              </GlassButton>
              <GlassButton
                data-testid="voice-discard-reference"
                disabled={busy}
                onClick={() => {
                  setPending(null);
                  setPendingName('');
                }}
              >
                Discard
              </GlassButton>
            </div>
          </div>
        )}

        {/* THE CONSENT AFFIRMATION — never pre-checked, resets with the chosen
            voice, and gates BOTH Save Voice and Convert (see the ruling in the
            component comment). Worded as the user's own statement. */}
        {(pending !== null || selectedProfileId !== null) && (
          <label
            className="flex items-center gap-2 text-xs"
            style={{ color: 'var(--glass-text-label)' }}
          >
            <input
              type="checkbox"
              data-testid="voice-consent"
              checked={consent}
              disabled={busy}
              onChange={(e) => setConsent(e.target.checked)}
              className="accent-[#26c6da]"
            />
            I have the right to use this voice.
          </label>
        )}

        {!modelMissing && !running && doc !== null && (
          <p data-testid="voice-estimate" className="text-xs" style={{ color: 'var(--glass-text-muted)' }}>
            {`Runs on the CPU at about ${MEASURED_REALTIME_FACTOR.toFixed(
              1
            )}x realtime — roughly ${formatSeconds(estimateSec)} for this document.`}
          </p>
        )}

        {running && (
          <div>
            <p
              data-testid="voice-progress-label"
              className="mb-1 text-xs"
              style={{ color: 'var(--glass-text-muted)' }}
            >
              {runLabel(progress, remaining)}
            </p>
            <ProgressTrack testId="voice-progress" fraction={progress?.fraction ?? 0} />
          </div>
        )}

        {note && (
          <p data-testid="voice-note" className="text-xs" style={{ color: 'var(--glass-text-secondary)' }}>
            {note}
          </p>
        )}

        {message && (
          <p data-testid="voice-error" className="text-xs text-[#e0a458]">
            {message}
          </p>
        )}

        <div className="mt-2 flex justify-end gap-2">
          {running || saving ? (
            <GlassButton onClick={() => void cancelVoiceRun()}>Cancel</GlassButton>
          ) : (
            <>
              <GlassButton onClick={onClose} disabled={downloading}>
                Close
              </GlassButton>
              {!modelMissing && (
                <GlassButton
                  data-testid="voice-convert"
                  variant="primary"
                  onClick={() => void handleConvert()}
                  disabled={!canConvert}
                >
                  Convert
                </GlassButton>
              )}
            </>
          )}
        </div>
      </div>
    </DialogShell>
  );
}

/** RemixDialog's inset progress track (the SeparateDialog copy). */
function ProgressTrack({ testId, fraction }: { testId: string; fraction: number }) {
  const percent = Math.round(Math.max(0, Math.min(1, fraction)) * 100);
  return (
    <div
      className="h-1.5 w-full overflow-hidden rounded-full"
      style={{ background: 'rgba(255, 255, 255, 0.09)', boxShadow: 'inset 0 1px 2px rgba(0, 0, 0, 0.6)' }}
    >
      <div
        data-testid={testId}
        className="h-full transition-[width]"
        style={{ width: `${percent}%`, background: 'var(--accent)', boxShadow: '0 0 8px var(--accent-ring)' }}
      />
    </div>
  );
}

/** Which pass, which chunk, how long left. Exported for the dialog test. */
export function runLabel(progress: VoiceProgress | null, remainingMs: number | null): string {
  const eta = remainingMs === null ? null : `${formatSeconds(remainingMs / 1000)} left`;
  if (!progress || progress.phase === 'resampling') {
    return eta ? `Preparing the audio… ${eta}` : 'Preparing the audio…';
  }
  const of = progress.total > 0 ? ` of ${progress.total}` : '';
  const head =
    progress.phase === 'embedding'
      ? `Reading the source voice — chunk ${progress.done}${of}`
      : `Converting — chunk ${progress.done}${of}`;
  return eta ? `${head} · ${eta}` : head;
}
