import { useEffect, useRef, useState } from 'react';
import { Layers } from 'lucide-react';
import { docLength } from '../../audio/AudioDocument';
import { useAppStore } from '../../stores/appStore';
import {
  MEASURED_REALTIME_FACTOR,
  cancelStemSeparation,
  ensureStemModel,
  getStemModelState,
  separateStems,
  type StemModelState,
  type StemSeparationOutput,
  type StemSeparationProgress,
} from '../../services/stemService';
import { STEM_TRACK_LABELS, landStems, type StemLandingResult } from '../../services/stemLanding';
import { GlassButton, SectionLabel } from '../UI/glass';
import DialogShell from './DialogShell';

/** `Drums, Bass, Vocals, Other and Residual` — derived from the ruling-6 order
 *  so a track-list change can never leave this sentence stale. */
const TRACK_LIST = `${STEM_TRACK_LABELS.slice(0, -1).join(', ')} and ${
  STEM_TRACK_LABELS[STEM_TRACK_LABELS.length - 1]
}`;

/** `m:ss` — the grain every duration in this dialog is expressed in
 *  (RemixDialog.tsx's own formatter; seconds are already finer than the
 *  estimate's real accuracy). */
function formatMmss(samples: number, sampleRate: number): string {
  const total = Number.isFinite(samples) ? Math.max(0, Math.round(samples / sampleRate)) : 0;
  const minutes = Math.floor(total / 60);
  return `${minutes}:${String(total - minutes * 60).padStart(2, '0')}`;
}

function formatSeconds(seconds: number): string {
  return formatMmss(Math.max(0, Math.round(seconds)), 1);
}

/** Decimal megabytes — the unit the 166 MB figure in the plan and on the
 *  Hugging Face page is quoted in. */
function formatMb(bytes: number): string {
  return `${Math.round(bytes / 1e6)} MB`;
}

/**
 * Task S6 — the Separate into Stems dialog (plan ruling 8). Minimal by
 * instruction: one dialog, four states (model missing / ready / running /
 * result), no options at all — the stem set is fixed at 4 + Residual for v1.7.
 *
 * What it owes the user, in order of importance:
 *
 * 1. **Ruling 1's two guarantees, told apart.** The sum is a HARD guarantee
 *    (the Residual is the time-domain complement, so the five tracks are a
 *    partition of the source by construction); the separation QUALITY is
 *    model-bounded and is never promised. The dialog states both before the
 *    user commits minutes of inference, and when `landStems` reports
 *    `exactSumHolds === false` — an over-unity source, whose peak exceeds ±1
 *    so the multitrack master's clamp breaks the identity — it says THAT
 *    instead of repeating a promise that does not hold for the document in
 *    hand. `exactSumHolds === null` (the source was closed, the check could not
 *    be made) is rendered as no claim at all, per S5's contract.
 * 2. **The 166 MB download, stated before it starts.** The model is never
 *    bundled (ruling 3); the size, the one-time-ness and any failure are all
 *    plain text, and the failure leaves the button usable.
 * 3. **Every service refusal inline, in amber** (`text-[#e0a458]`, the app's
 *    convention) — never a `showMessageBox`, so the dialog stays open and the
 *    user can react. All nine `StemSeparationStatus` values render; the
 *    service's own messages are used verbatim, because they are already
 *    user-facing and duplicating them here would let the two drift.
 *
 * Lifetime: `dismissable={!busy}` so neither Escape nor a backdrop click can
 * discard a running download or separation; the unmount cleanup CANCELS an
 * in-flight run (EffectDialog/RemixDialog's busyRef pattern, extended with the
 * kill because a stem run owns a ~5 GB utility process that must not outlive
 * the dialog that started it); and the target document is resolved from LIVE
 * store state at confirm time, never captured at open.
 */
export default function SeparateDialog({ onClose }: { onClose: () => void }) {
  const doc = useAppStore((s) => s.documents.find((d) => d.id === s.activeDocumentId) ?? null);
  const length = doc ? docLength(doc) : 0;

  const [model, setModel] = useState<StemModelState | null>(null);
  const [downloading, setDownloading] = useState(false);
  const [received, setReceived] = useState(0);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<StemSeparationProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notes, setNotes] = useState<{ exactness: string | null; sanitised: string | null } | null>(null);

  const busy = downloading || running;

  // The unmount mirror (RemixDialog.tsx:124's cancelledRef): a ref, because the
  // cleanup must read the CURRENT value, not the one captured when the effect
  // was installed. Every async continuation checks it before touching state.
  const unmountedRef = useRef(false);
  // Separate ref for the RUN, because unmounting must do more than stay quiet:
  // an orphaned separation would hold the close guard's busy count up and keep
  // a multi-gigabyte utility process alive for stems nobody can receive.
  const runningRef = useRef(false);

  useEffect(() => {
    unmountedRef.current = false;
    return () => {
      unmountedRef.current = true;
      if (runningRef.current) {
        runningRef.current = false;
        void cancelStemSeparation();
      }
    };
  }, []);

  useEffect(() => {
    void (async () => {
      const state = await getStemModelState();
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
    let result: Awaited<ReturnType<typeof ensureStemModel>>;
    try {
      result = await ensureStemModel((p) => {
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
    const state = await getStemModelState();
    if (!unmountedRef.current) setModel(state);
  }

  async function handleSeparate(): Promise<void> {
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
    setNotes(null);
    let result: Awaited<ReturnType<typeof separateStems>>;
    try {
      result = await separateStems({
        sourceDocId: live.id,
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
      // A refusal for the missing model is not an error to stare at — it is
      // the download state, so put the button back in front of the user.
      if (result.status === 'model-missing') {
        setModel({ downloaded: false, bytes: null, expectedBytes: model?.expectedBytes ?? 0 });
      }
      return;
    }

    // S5 does the landing: five documents, one session, the multitrack view.
    const landing = landStems(result.output);
    if (unmountedRef.current) return;
    const advisories = buildNotes(landing, result.output);
    if (!advisories.exactness && !advisories.sanitised) {
      onClose();
      return;
    }
    setNotes(advisories);
  }

  const expectedBytes = model?.expectedBytes ?? 0;
  const modelMissing = model !== null && !model.downloaded;
  const canSeparate = !busy && notes === null && doc !== null && length > 0 && model?.downloaded === true;
  const message = error ?? (doc === null ? 'No document is open.' : null);

  const estimateSeconds = doc ? length / doc.sampleRate / MEASURED_REALTIME_FACTOR : 0;
  const remaining = progress?.estimatedRemainingMs ?? null;

  return (
    <DialogShell
      title="Separate into Stems"
      subtitle={doc ? `${doc.name} · ${formatMmss(length, doc.sampleRate)}` : undefined}
      icon={<Layers size={15} />}
      width={480}
      onClose={onClose}
      dismissable={!busy}
    >
      <div className="flex flex-col gap-3" data-testid="separate-dialog">
        <SectionLabel>What you get</SectionLabel>

        <p data-testid="separate-produces" className="text-xs" style={{ color: 'var(--glass-text-label)' }}>
          {`Five tracks in a new multitrack session: ${TRACK_LIST} — the Residual holding everything the model could not place.`}
        </p>

        <p data-testid="separate-guarantees" className="text-xs" style={{ color: 'var(--glass-text-secondary)' }}>
          The five tracks always add back up to your original, sample for sample — no audio is lost. How
          cleanly the instruments are told apart is bounded by the model, so expect some bleed between them;
          that is a limit of the separation, not a bug.
        </p>

        {modelMissing && (
          <div data-testid="separate-model-missing" className="flex flex-col gap-2">
            <SectionLabel>Model</SectionLabel>
            <p className="text-xs" style={{ color: 'var(--glass-text-label)' }}>
              {`Separation needs the HT-Demucs model — a ${formatMb(
                expectedBytes
              )} one-time download, kept with the app's settings and reused for every later separation.`}
            </p>
            {downloading ? (
              <div>
                <p
                  data-testid="separate-download-status"
                  className="mb-1 text-xs"
                  style={{ color: 'var(--glass-text-muted)' }}
                >
                  {`Downloading… ${formatMb(received)} of ${formatMb(expectedBytes)}`}
                </p>
                <ProgressTrack
                  testId="separate-download-progress"
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

        {!modelMissing && !running && notes === null && (
          <p data-testid="separate-estimate" className="text-xs" style={{ color: 'var(--glass-text-muted)' }}>
            {`Runs on the CPU at about ${MEASURED_REALTIME_FACTOR.toFixed(
              1
            )}x realtime — roughly ${formatSeconds(estimateSeconds)} for this document.`}
          </p>
        )}

        {running && (
          <div>
            <p
              data-testid="separate-progress-label"
              className="mb-1 text-xs"
              style={{ color: 'var(--glass-text-muted)' }}
            >
              {runLabel(progress, remaining)}
            </p>
            <ProgressTrack testId="separate-progress" fraction={progress?.fraction ?? 0} />
          </div>
        )}

        {notes && (
          <>
            <SectionLabel>Result</SectionLabel>
            {notes.exactness && (
              <p data-testid="separate-note-exactness" className="text-xs text-[#e0a458]">
                {notes.exactness}
              </p>
            )}
            {notes.sanitised && (
              <p
                data-testid="separate-note-sanitised"
                className="text-xs"
                style={{ color: 'var(--glass-text-secondary)' }}
              >
                {notes.sanitised}
              </p>
            )}
          </>
        )}

        {message && (
          <p data-testid="separate-error" className="text-xs text-[#e0a458]">
            {message}
          </p>
        )}

        <div className="mt-2 flex justify-end gap-2">
          {running ? (
            <GlassButton onClick={() => void cancelStemSeparation()}>Cancel</GlassButton>
          ) : (
            <>
              <GlassButton onClick={onClose} disabled={downloading}>
                Close
              </GlassButton>
              {!modelMissing && notes === null && (
                <GlassButton variant="primary" onClick={() => void handleSeparate()} disabled={!canSeparate}>
                  Separate
                </GlassButton>
              )}
            </>
          )}
        </div>
      </div>
    </DialogShell>
  );
}

/** RemixDialog's inset progress track, the one place this dialog repeats a
 *  shape often enough to name it. */
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

/** Ruling 7's progress line: which segment, and how long is left. */
function runLabel(progress: StemSeparationProgress | null, remainingMs: number | null): string {
  const eta = remainingMs === null ? null : `${formatSeconds(remainingMs / 1000)} left`;
  if (!progress || progress.phase === 'resampling') {
    return eta ? `Preparing the audio… ${eta}` : 'Preparing the audio…';
  }
  if (progress.phase === 'partitioning') return 'Building the stems…';
  const of = progress.totalSegments > 0 ? ` of ${progress.totalSegments}` : '';
  const head = `Separating — segment ${progress.segment}${of}`;
  return eta ? `${head} · ${eta}` : head;
}

/**
 * The two things a finished run may have to admit. Both are deliberately
 * post-hoc: the sanitised count is only known after inference, and the
 * exactness verdict is `landStems`' own measurement of the source.
 */
function buildNotes(
  landing: StemLandingResult,
  output: StemSeparationOutput
): { exactness: string | null; sanitised: string | null } {
  // `exactSumHolds === null` means the check could not be made (S5's contract).
  // Silence is the honest rendering of that — not a claim in either direction.
  const exactness =
    landing.exactSumHolds === false
      ? `This document peaks above full scale (${(landing.sourcePeak ?? 0).toFixed(
          2
        )}), so the multitrack master clamps at ±1 and the five tracks will not add back to it exactly. The stems themselves are complete — reduce the source level and separate again if you need the exact sum.`
      : null;
  const sanitised =
    output.sanitisedEstimateSamples > 0
      ? `The model returned ${output.sanitisedEstimateSamples} non-finite value(s), which were zeroed; that energy went to the Residual track. The sum is still exact — only the separation around those samples is less clean.`
      : null;
  return { exactness, sanitised };
}
