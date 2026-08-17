import { useEffect, useRef, useState } from 'react';
import { Captions } from 'lucide-react';
import { docLength } from '../../audio/AudioDocument';
import { useAppStore } from '../../stores/appStore';
import {
  DIARIZATION_LIMITS,
  MAX_SPEAKERS,
  MEASURED_REALTIME_FACTOR,
  cancelTranscription,
  ensureTranscribeModels,
  getTranscribeModelState,
  transcribeDocument,
  type TranscribeModelState,
  type TranscribeProgress,
} from '../../services/transcribeService';
import { focusTranscriptPanel } from '../../services/dialogBus';
import { GlassButton, GlassSelect, SectionLabel } from '../UI/glass';
import DialogShell from './DialogShell';

/** `m:ss` — the grain every duration in this dialog is expressed in
 *  (SeparateDialog.tsx's own formatter). */
function formatMmss(samples: number, sampleRate: number): string {
  const total = Number.isFinite(samples) ? Math.max(0, Math.round(samples / sampleRate)) : 0;
  const minutes = Math.floor(total / 60);
  return `${minutes}:${String(total - minutes * 60).padStart(2, '0')}`;
}

function formatSeconds(seconds: number): string {
  return formatMmss(Math.max(0, Math.round(seconds)), 1);
}

/** Decimal megabytes — the unit Hugging Face quotes file sizes in, and the one
 *  SeparateDialog already uses. */
function formatMb(bytes: number): string {
  return `${Math.round(bytes / 1e6)} MB`;
}

/** `AUTO_SPEAKERS` is the select's value for "detect it"; the service takes
 *  `undefined` for the same thing. A sentinel string is used rather than an
 *  empty value so the option is addressable in a test by its own name. */
const AUTO_SPEAKERS = 'auto';

/**
 * F4b — the Transcribe dialog. SeparateDialog's shape: one dialog, four states
 * (models missing / ready / running / done), the download stated before it
 * starts, every refusal inline in amber rather than a `showMessageBox` so the
 * dialog stays open and the user can react.
 *
 * Two things are specific to this feature, and both are honesty obligations
 * rather than decoration:
 *
 * 1. **The speaker count is offered UP FRONT, and the auto option says what it
 *    is worth.** Auto-detection was measured at 100% on two speakers and 45%
 *    on three (`DIARIZATION_LIMITS`, from the F4 bench). A picker that just
 *    said "Auto" would imply a confidence the measurement does not support, so
 *    the option is labelled with its own range and the sentence beneath states
 *    the three-speaker number outright.
 * 2. **The measurement's conditions are stated, not just its result.** The
 *    bench material was concatenated single-speaker recordings with no
 *    overlapping speech, so the dialog says overlap is not handled at all
 *    rather than letting 100% read as a field expectation.
 *
 * The count chosen here is only the STARTING point: it can be changed after
 * the fact in the Transcript panel, which re-clusters the stored embeddings
 * without re-running Whisper. The dialog says so, because otherwise a user who
 * guesses wrong would think they had to transcribe again.
 *
 * Lifetime: `dismissable={!busy}` so neither Escape nor a backdrop click can
 * discard a running download or run, and the unmount cleanup CANCELS an
 * in-flight run — an orphaned transcription would hold the close guard's busy
 * count up and keep a utility process alive for a transcript nobody can
 * receive.
 */
export default function TranscribeDialog({ onClose }: { onClose: () => void }) {
  const doc = useAppStore((s) => s.documents.find((d) => d.id === s.activeDocumentId) ?? null);
  const length = doc ? docLength(doc) : 0;

  const [model, setModel] = useState<TranscribeModelState | null>(null);
  const [downloading, setDownloading] = useState(false);
  const [received, setReceived] = useState(0);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<TranscribeProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [speakers, setSpeakers] = useState<string>(AUTO_SPEAKERS);

  const busy = downloading || running;

  // The unmount mirror (SeparateDialog.tsx:94's unmountedRef): a ref, because
  // the cleanup must read the CURRENT value, not the one captured when the
  // effect was installed.
  const unmountedRef = useRef(false);
  const runningRef = useRef(false);

  useEffect(() => {
    unmountedRef.current = false;
    return () => {
      unmountedRef.current = true;
      if (runningRef.current) {
        runningRef.current = false;
        void cancelTranscription();
      }
    };
  }, []);

  useEffect(() => {
    void (async () => {
      const state = await getTranscribeModelState();
      if (!unmountedRef.current) setModel(state);
    })();
  }, []);

  function liveDoc() {
    const state = useAppStore.getState();
    return state.documents.find((d) => d.id === state.activeDocumentId) ?? null;
  }

  async function handleDownload(): Promise<void> {
    setDownloading(true);
    setError(null);
    setReceived(0);
    let result: Awaited<ReturnType<typeof ensureTranscribeModels>>;
    try {
      result = await ensureTranscribeModels((p) => {
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
    const state = await getTranscribeModelState();
    if (!unmountedRef.current) setModel(state);
  }

  async function handleTranscribe(): Promise<void> {
    // Resolved from LIVE state, never captured at open.
    const live = liveDoc();
    if (!live) {
      setError('No document is open.');
      return;
    }

    setRunning(true);
    runningRef.current = true;
    setProgress(null);
    setError(null);
    let result: Awaited<ReturnType<typeof transcribeDocument>>;
    try {
      result = await transcribeDocument({
        docId: live.id,
        speakerCount: speakers === AUTO_SPEAKERS ? undefined : Number(speakers),
        onProgress: (p) => {
          if (!unmountedRef.current) setProgress(p);
        },
      });
    } finally {
      runningRef.current = false;
      if (!unmountedRef.current) setRunning(false);
    }

    if (!result.ok) {
      if (unmountedRef.current) return;
      setError(result.message);
      // A refusal for the missing models is not an error to stare at — it is
      // the download state, so put the button back in front of the user.
      if (result.status === 'model-missing') {
        setModel({ downloaded: false, bytes: null, expectedBytes: model?.expectedBytes ?? 0 });
      }
      return;
    }

    if (unmountedRef.current) return;
    // The transcript lives in the panel, so send the user there rather than
    // leaving them looking at a dialog that has nothing left to say.
    focusTranscriptPanel();
    onClose();
  }

  const expectedBytes = model?.expectedBytes ?? 0;
  const modelMissing = model !== null && !model.downloaded;
  const canRun = !busy && doc !== null && length > 0 && model?.downloaded === true;
  const message = error ?? (doc === null ? 'No document is open.' : null);
  const estimateSeconds = doc ? length / doc.sampleRate / MEASURED_REALTIME_FACTOR : 0;
  const remaining = progress?.estimatedRemainingMs ?? null;

  return (
    <DialogShell
      title="Transcribe"
      subtitle={doc ? `${doc.name} · ${formatMmss(length, doc.sampleRate)}` : undefined}
      icon={<Captions size={15} />}
      width={480}
      onClose={onClose}
      dismissable={!busy}
    >
      <div className="flex flex-col gap-3" data-testid="transcribe-dialog">
        <SectionLabel>What you get</SectionLabel>

        <p data-testid="transcribe-produces" className="text-xs" style={{ color: 'var(--glass-text-label)' }}>
          Timestamped text in the Transcript panel, one row per spoken segment, each labelled with a
          speaker. Clicking a row moves the cursor there, and the transcript exports as SRT or WebVTT
          subtitles.
        </p>

        <SectionLabel>Speakers</SectionLabel>

        <GlassSelect
          data-testid="transcribe-speakers"
          aria-label="Number of speakers"
          value={speakers}
          disabled={busy}
          onChange={(e) => setSpeakers(e.target.value)}
        >
          <option value={AUTO_SPEAKERS}>
            {`Detect automatically (reliable for 1–${DIARIZATION_LIMITS.reliableUpTo})`}
          </option>
          {/* The full range: before the run there are no embeddings, so there
              is no tighter honest ceiling. The Transcript panel narrows it to
              what the finished transcript can actually separate, and a count
              this dialog accepts but the evidence cannot support is refused
              by `validateSpeakerCount` with a message rather than silently
              downgraded. */}
          {Array.from({ length: MAX_SPEAKERS }, (_, i) => i + 1).map((n) => (
            <option key={n} value={String(n)}>
              {n === 1 ? '1 speaker' : `${n} speakers`}
            </option>
          ))}
        </GlassSelect>

        <p data-testid="transcribe-diarization-note" className="text-xs" style={{ color: 'var(--glass-text-secondary)' }}>
          {`Speaker separation was measured on clean recordings with one voice at a time: it told two speakers apart correctly on all of them, but got only ${Math.round(
            DIARIZATION_LIMITS.threeSpeakerAccuracy * 100
          )}% of segments right with three — ${Math.round(
            DIARIZATION_LIMITS.threeSpeakerAccuracyWhenTold * 100
          )}% even when told there were three. Overlapping speech is not detected at all; a segment with two voices in it gets one label. You can change the number of speakers afterwards in the Transcript panel without transcribing again.`}
        </p>

        {modelMissing && (
          <div data-testid="transcribe-model-missing" className="flex flex-col gap-2">
            <SectionLabel>Models</SectionLabel>
            <p className="text-xs" style={{ color: 'var(--glass-text-label)' }}>
              {`Transcription needs the Whisper and speaker-embedding models — a ${formatMb(
                expectedBytes
              )} one-time download, kept with the app's settings and reused for every later transcription.`}
            </p>
            {downloading ? (
              <div>
                <p
                  data-testid="transcribe-download-status"
                  className="mb-1 text-xs"
                  style={{ color: 'var(--glass-text-muted)' }}
                >
                  {`Downloading… ${formatMb(received)} of ${formatMb(expectedBytes)}`}
                </p>
                <ProgressTrack
                  testId="transcribe-download-progress"
                  fraction={expectedBytes > 0 ? received / expectedBytes : 0}
                />
              </div>
            ) : (
              <div>
                <GlassButton variant="primary" onClick={() => void handleDownload()}>
                  Download Models
                </GlassButton>
              </div>
            )}
          </div>
        )}

        {!modelMissing && !running && (
          <p data-testid="transcribe-estimate" className="text-xs" style={{ color: 'var(--glass-text-muted)' }}>
            {`Runs on the CPU at about ${MEASURED_REALTIME_FACTOR.toFixed(
              1
            )}x realtime — roughly ${formatSeconds(estimateSeconds)} for this document.`}
          </p>
        )}

        {running && (
          <div>
            <p
              data-testid="transcribe-progress-label"
              className="mb-1 text-xs"
              style={{ color: 'var(--glass-text-muted)' }}
            >
              {runLabel(progress, remaining)}
            </p>
            <ProgressTrack testId="transcribe-progress" fraction={progress?.fraction ?? 0} />
          </div>
        )}

        {message && (
          <p data-testid="transcribe-error" className="text-xs text-[#e0a458]">
            {message}
          </p>
        )}

        <div className="mt-2 flex justify-end gap-2">
          {running ? (
            <GlassButton onClick={() => void cancelTranscription()}>Cancel</GlassButton>
          ) : (
            <>
              <GlassButton onClick={onClose} disabled={downloading}>
                Close
              </GlassButton>
              {!modelMissing && (
                <GlassButton variant="primary" onClick={() => void handleTranscribe()} disabled={!canRun}>
                  Transcribe
                </GlassButton>
              )}
            </>
          )}
        </div>
      </div>
    </DialogShell>
  );
}

/** SeparateDialog's inset progress track. */
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

/** Which phase, how far through it, and how long is left. */
export function runLabel(progress: TranscribeProgress | null, remainingMs: number | null): string {
  const eta = remainingMs === null ? null : `${formatSeconds(remainingMs / 1000)} left`;
  if (!progress || progress.phase === 'resampling') {
    return eta ? `Preparing the audio… ${eta}` : 'Preparing the audio…';
  }
  if (progress.phase === 'clustering') return 'Grouping the voices…';
  if (progress.phase === 'embedding') {
    const of = progress.total > 0 ? ` ${progress.done} of ${progress.total}` : '';
    const head = `Measuring voices —${of || ' working'}`;
    return eta ? `${head} · ${eta}` : head;
  }
  const percent = progress.total > 0 ? ` — ${Math.round(progress.fraction * 100)}%` : '';
  const head = `Transcribing${percent}`;
  return eta ? `${head} · ${eta}` : head;
}
