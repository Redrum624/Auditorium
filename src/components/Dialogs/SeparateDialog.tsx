import { useEffect, useRef, useState } from 'react';
import { Layers, Mic } from 'lucide-react';
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
import {
  SPEAKER_LANDING_BUDGET_BYTES,
  STEM_TRACK_LABELS,
  landSpeakers,
  landStems,
  landVoice,
  speakerDocumentBytes,
  type StemLandingResult,
} from '../../services/stemLanding';
import {
  DIARIZE_MODEL_BYTES,
  MEASURED_EMBED_MS_PER_S,
  MEASURED_SEGMENT_MS_PER_S,
  cancelDiarization,
  diarizeChannels,
  ensureDiarizeModels,
  getDiarizeModelState,
  limitsSentence,
  stageWeights,
  type DiarizeModelState,
  type DiarizeProgress,
  type DiarizeResult,
} from '../../services/diarizeService';
import {
  MAX_SPEAKERS,
  reclusterDiarization,
  segmentsToDocSamples,
  type Diarization,
  type DiarizationEvidence,
} from '../../dsp/diarization';
import type { SeparateMode } from '../../services/dialogBus';
import { GlassButton, GlassSelect, SectionLabel } from '../UI/glass';
import DialogShell from './DialogShell';

/** `A, B and C` — the labels themselves, so a track-list change can never
 *  leave one of these sentences stale. */
function trackList(labels: readonly string[]): string {
  return `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1]}`;
}

/** `Drums, Bass, Vocals, Other and Residual` — the ruling-6 order. */
const TRACK_LIST = trackList(STEM_TRACK_LABELS);

/**
 * D5 — the three stages' shares of one Separate Voice run, computed ONCE from
 * the three measured seeds (`stageWeights()`: Demucs' 1/1.52 s per audio
 * second, 8 ms of segmentation, 55 ms of embedding). Never written down as
 * 0.91 / 0.01 / 0.08 here: a literal copy would drift the first time one of
 * those seeds is re-measured, and the whole point of a weighted bar is that
 * its weights are the measured ones.
 */
const STAGE_SHARES = stageWeights();

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
 * The size of ONE model set, for the gate's per-set lines.
 *
 * THREE significant figures, which is exactly the precision both of D5's
 * figures are quoted at: 165,612,636 B is "166 MB" and 32,523,463 B is
 * "32.5 MB". {@link formatMb}'s whole megabytes would print the speaker set as
 * "33 MB" while the plan, the README and the docs all say 32.5 — two numbers
 * for one download — and a fixed tenth would print the Demucs set as "165.6 MB"
 * against the 166 quoted everywhere else. The download PROGRESS line keeps
 * whole megabytes: a decimal that changes ten times a second is noise.
 */
function formatModelSize(bytes: number): string {
  return `${Number((bytes / 1e6).toPrecision(3))} MB`;
}

/**
 * D4's memory figures: megabytes to a tenth below a gigabyte, gigabytes above
 * it. The speaker landing's whole cost lives on both sides of that line — one
 * 15-minute stereo speaker document is 317.5 MB and six of them are 1.9 GB —
 * and a panel that quoted "1905 MB" would make the reader do the division that
 * decides whether they can afford the landing.
 */
function formatBytes(bytes: number): string {
  return bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : `${(bytes / 1e6).toFixed(1)} MB`;
}

/** The live stage of a run, and what a Cancel or an unmount has to kill.
 *  `review` is deliberately NOT a stage: nothing is running behind it. */
type RunStage = 'idle' | 'separating' | 'diarizing';

/** Everything the confirmation step (D5) needs, and everything a re-cluster
 *  needs — the evidence is kept so a different speaker count costs no model
 *  run at all. */
interface SpeakerReview {
  output: StemSeparationOutput;
  evidence: DiarizationEvidence;
  diarization: Diarization;
  /** The count the user ASKED for, or null while the auto policy's answer
   *  stands. Kept apart from `diarization.speakerCount` because the two differ
   *  whenever a cluster fell under the share floor, and that difference is
   *  exactly what the headline has to say out loud. */
  requested: number | null;
}

/** D5 — what the speaker stage says before the host has counted anything. */
const LISTENING_LABEL = 'Listening for speakers…';

/** The cancel a discarded stem result reports. The same sentence
 *  `diarizeService` uses for its own cancel, so the two doors of D5's
 *  cancellation read identically to the user. */
const CANCELLED_MESSAGE = 'Speaker separation was cancelled.';

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
 * D5 — TWO commands, one dialog, and in voice mode a THREE-stage run:
 *
 *   1. `separateStems` — HT-Demucs, unchanged, Vocals + Backing in memory.
 *   2. `diarizeChannels(vocals)` — the segmentation + embedding host.
 *   3. the CONFIRMATION step, from which the user lands.
 *
 * `mode` picks the landing: `stems` (the five tracks, `edit.separateStems`) or
 * `voice` (the speaker split, `voice.separate`). Stems mode is untouched by
 * the speaker work — same title, same two sentences, same landing, same
 * auto-close — because nothing about it changed.
 *
 * Three things earn the confirmation step its place, and each is a thing that
 * cannot be undone cheaply once it has happened:
 *
 *   - A speaker COUNT is a guess. The auto policy is measured on four
 *     recordings (`SPEAKER_SEPARATION_LIMITS`) and the panel says so in the
 *     same breath as it offers the count for correction.
 *   - Landing N speakers builds N FULL-LENGTH documents — 317.5 MB each for a
 *     15-minute stereo source (D4) — so the panel prices the landing before it
 *     happens and refuses one that would not fit (`SPEAKER_LANDING_BUDGET_BYTES`).
 *   - Re-counting is free (`reclusterDiarization` over the kept evidence) but
 *     only until the run is thrown away. Landing first and re-counting after
 *     would cost a second five-minute model pass.
 *
 * Lifetime: `dismissable={!busy}` so neither Escape nor a backdrop click can
 * discard a running download or separation; the unmount cleanup CANCELS an
 * in-flight run — dispatched by the LIVE stage, because the two stages own two
 * different utility processes and killing the wrong one leaves a ~5 GB child
 * alive; and the target document is resolved from LIVE store state at confirm
 * time, never captured at open. An unmount during the REVIEW cancels nothing
 * (nothing is running) and lands nothing (the user never pressed Land).
 */
export default function SeparateDialog({
  onClose,
  mode = 'stems',
}: {
  onClose: () => void;
  /** D4. Defaults to the five-stem landing this dialog has always done, so
   *  `edit.separateStems` and every existing caller are unchanged. */
  mode?: SeparateMode;
}) {
  const voice = mode === 'voice';
  const doc = useAppStore((s) => s.documents.find((d) => d.id === s.activeDocumentId) ?? null);
  const length = doc ? docLength(doc) : 0;

  const [stemModel, setStemModel] = useState<StemModelState | null>(null);
  const [speakerModel, setSpeakerModel] = useState<DiarizeModelState | null>(null);
  const [downloading, setDownloading] = useState(false);
  const [downloadingSet, setDownloadingSet] = useState<'stems' | 'speakers'>('stems');
  const [received, setReceived] = useState(0);
  /** Bytes of the sets that have already finished, so the ONE bar D5 asks for
   *  does not fall back to zero when the second download starts. */
  const [downloadedBase, setDownloadedBase] = useState(0);
  const [stage, setStage] = useState<RunStage>('idle');
  const [progress, setProgress] = useState<StemSeparationProgress | null>(null);
  const [speakerLabel, setSpeakerLabel] = useState<string>(LISTENING_LABEL);
  /** The whole run's progress, weighted by {@link STAGE_SHARES} and clamped
   *  never to fall: a straggling event from a finished stage must not walk the
   *  bar backwards in front of the user. */
  const [overall, setOverall] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [notes, setNotes] = useState<{ exactness: string | null; sanitised: string | null } | null>(null);
  const [review, setReview] = useState<SpeakerReview | null>(null);

  const running = stage !== 'idle';
  const busy = downloading || running;

  // The unmount mirror (RemixDialog.tsx:124's cancelledRef): a ref, because the
  // cleanup must read the CURRENT value, not the one captured when the effect
  // was installed. Every async continuation checks it before touching state.
  const unmountedRef = useRef(false);
  // Separate ref for the RUN's stage, because unmounting must do more than stay
  // quiet: an orphaned separation would hold the close guard's busy count up and
  // keep a multi-gigabyte utility process alive for stems nobody can receive —
  // and the speaker stage owns a DIFFERENT child, so the cleanup dispatches on
  // this rather than killing both (D5).
  const stageRef = useRef<RunStage>('idle');
  // D5's user-pressed Cancel, which is not the same event as an unmount: it is
  // polled by `diarizeChannels` (`shouldCancel`) so a Cancel raised while stage
  // 1 was finishing spawns NOTHING, and it is what makes a stem result that
  // arrived after the press get discarded instead of landed.
  const cancelledRef = useRef(false);

  useEffect(() => {
    unmountedRef.current = false;
    return () => {
      unmountedRef.current = true;
      const live = stageRef.current;
      stageRef.current = 'idle';
      if (live === 'separating') void cancelStemSeparation();
      else if (live === 'diarizing') void cancelDiarization();
    };
  }, []);

  useEffect(() => {
    void (async () => {
      const state = await getStemModelState();
      if (!unmountedRef.current) setStemModel(state);
    })();
    void (async () => {
      // Only voice mode has a second set to gate on, and probing it in stems
      // mode would be an IPC round trip for a state that is never rendered.
      // `mode` never changes for a mounted dialog (the bus opens a new one),
      // so the empty dependency list is the honest one.
      if (!voice) return;
      const state = await getDiarizeModelState();
      if (!unmountedRef.current) setSpeakerModel(state);
    })();
  }, []);

  function liveDoc() {
    const state = useAppStore.getState();
    return state.documents.find((d) => d.id === state.activeDocumentId) ?? null;
  }

  /** The bar only ever moves forward (D5's monotone overall progress). */
  function bumpOverall(fraction: number): void {
    setOverall((prev) => (fraction > prev ? fraction : prev));
  }

  const stemExpected = stemModel?.expectedBytes ?? 0;
  const speakerExpected = speakerModel?.expectedBytes ?? DIARIZE_MODEL_BYTES;
  const needStems = stemModel?.downloaded !== true;
  const needSpeakers = voice && speakerModel?.downloaded !== true;
  /** One bar over the SUM of the sets actually being fetched (D5). */
  const downloadTotal = (needStems ? stemExpected : 0) + (needSpeakers ? speakerExpected : 0);

  async function handleDownload(): Promise<void> {
    setDownloading(true);
    setError(null);
    setReceived(0);
    setDownloadedBase(0);
    // Captured here, not read from state inside the loop: the two ensures run
    // sequentially across awaits and the state they would read is the state
    // from the render that started the download either way.
    const stemBytes = stemExpected;
    const wantStems = needStems;
    const wantSpeakers = needSpeakers;
    try {
      if (wantStems) {
        setDownloadingSet('stems');
        const result = await ensureStemModel((p) => {
          if (!unmountedRef.current) setReceived(p.received);
        });
        if (unmountedRef.current) return;
        if (!result.ok) {
          setError(result.error);
          return;
        }
        // The finished set's whole size, not its last progress event: the last
        // event is not guaranteed to be the total.
        setDownloadedBase(stemBytes);
        setReceived(0);
      }
      if (wantSpeakers) {
        setDownloadingSet('speakers');
        const result = await ensureDiarizeModels((p) => {
          if (!unmountedRef.current) setReceived(p.received);
        });
        if (unmountedRef.current) return;
        if (!result.ok) {
          setError(result.error);
          return;
        }
      }
    } finally {
      if (!unmountedRef.current) setDownloading(false);
      // Re-probed on EVERY exit path, not only the all-green one: with two
      // sequential ensures (D5) the interesting exit is the half-finished one.
      // When Demucs lands and the speaker set then fails, a probe skipped by an
      // early return leaves the gate reading "needed" for a set that is now on
      // disk — and since `downloadTotal` is built from those same flags, the
      // retry would re-price the 166 MB set and re-run its ensure over it.
      if (!unmountedRef.current) {
        const nextStem = await getStemModelState();
        if (!unmountedRef.current) setStemModel(nextStem);
      }
      if (voice && !unmountedRef.current) {
        const nextSpeaker = await getDiarizeModelState();
        if (!unmountedRef.current) setSpeakerModel(nextSpeaker);
      }
    }
  }

  async function handleSeparate(): Promise<void> {
    // Resolved from LIVE state, never captured at open.
    const live = liveDoc();
    if (!live) {
      setError('No document is open.');
      return;
    }

    cancelledRef.current = false;
    setStage('separating');
    stageRef.current = 'separating';
    setProgress(null);
    setSpeakerLabel(LISTENING_LABEL);
    setOverall(0);
    setError(null);
    setNotes(null);
    setReview(null);
    let result: Awaited<ReturnType<typeof separateStems>>;
    try {
      result = await separateStems({
        sourceDocId: live.id,
        onProgress: (p) => {
          if (unmountedRef.current) return;
          setProgress(p);
          if (voice) bumpOverall(STAGE_SHARES.separate * p.fraction);
        },
      });
    } finally {
      stageRef.current = 'idle';
      // In voice mode the run is not over — stage 2 starts below without ever
      // showing the idle state, so the dialog never flashes its ready buttons
      // between two halves of one run.
      if (!voice && !unmountedRef.current) setStage('idle');
    }

    if (unmountedRef.current) return;
    if (!result.ok) {
      if (voice) setStage('idle');
      setError(result.message);
      // A refusal for the missing model is not an error to stare at — it is
      // the download state, so put the button back in front of the user.
      if (result.status === 'model-missing') {
        setStemModel({ downloaded: false, bytes: null, expectedBytes: stemModel?.expectedBytes ?? 0 });
      }
      return;
    }

    if (!voice) {
      // S5 does the landing: five documents, one session, the multitrack view.
      const landing = landStems(result.output);
      const advisories = {
        exactness: exactnessNote(landing, mode),
        sanitised: sanitisedNote(result.output, mode, null),
      };
      if (!advisories.exactness && !advisories.sanitised) {
        onClose();
        return;
      }
      setNotes(advisories);
      return;
    }

    await runSpeakerStage(result.output);
  }

  /** D1 stages 2 and 3, then the confirmation step. Nothing lands here. */
  async function runSpeakerStage(output: StemSeparationOutput): Promise<void> {
    // D5: a Cancel raised while Demucs was finishing DISCARDS its result and
    // spawns no diarizer. The stems are gone either way — the user asked for
    // the run to stop, and landing half of what they cancelled is worse than
    // landing nothing.
    if (cancelledRef.current) {
      setStage('idle');
      setError(CANCELLED_MESSAGE);
      return;
    }

    setStage('diarizing');
    stageRef.current = 'diarizing';
    // Stage 1 is done, so the bar stands at its full weight even before the
    // host's first event.
    bumpOverall(STAGE_SHARES.separate);
    setSpeakerLabel(LISTENING_LABEL);

    // By LABEL, exactly as `landVoice`/`landSpeakers` select it: `stemService`
    // does not guarantee the host's stem order. Read, never copied — the
    // Vocals stem is hundreds of megabytes.
    const vocals = output.stems.find((s) => s.label === 'Vocals')?.channels ?? [];
    let result: DiarizeResult;
    try {
      result = await diarizeChannels({
        channels: vocals,
        sampleRate: output.sampleRate,
        shouldCancel: () => cancelledRef.current,
        onProgress: (p) => {
          if (unmountedRef.current) return;
          bumpOverall(STAGE_SHARES.separate + (STAGE_SHARES.segment + STAGE_SHARES.embed) * p.fraction);
          const label = speakerStageLabel(p);
          if (label !== null) setSpeakerLabel(label);
        },
      });
    } finally {
      stageRef.current = 'idle';
      if (!unmountedRef.current) setStage('idle');
    }

    if (unmountedRef.current) return;
    if (!result.ok) {
      setError(result.message);
      if (result.status === 'model-missing') {
        setSpeakerModel({ downloaded: false, bytes: null, expectedBytes: speakerExpected });
      }
      return;
    }
    setReview({ output, evidence: result.evidence, diarization: result.diarization, requested: null });
  }

  /** D5's select: the same evidence at a forced count, no model re-run. */
  function handleSpeakerCount(next: number): void {
    if (!review) return;
    setReview({ ...review, requested: next, diarization: reclusterDiarization(review.evidence, next) });
  }

  /** One Cancel, dispatched by the stage that is actually live (D5). */
  function handleCancel(): void {
    cancelledRef.current = true;
    if (stageRef.current === 'diarizing') void cancelDiarization();
    else void cancelStemSeparation();
  }

  function handleLand(): void {
    if (!review) return;
    const { output, diarization } = review;
    const count = diarization.speakerCount;
    if (count >= 2) {
      if (landingBytes > SPEAKER_LANDING_BUDGET_BYTES) return;
      // D4 takes DOCUMENT samples, not the 16 kHz model positions.
      landSpeakers(output, segmentsToDocSamples(diarization, output.sampleRate, output.lengthSamples));
      onClose();
      return;
    }
    // D4: a confirmed count of one (or no evidence at all) is Voice + Backing,
    // unmasked — there is nobody to separate the voice from, and the edge fades
    // would only shave the ends off the user's own speech.
    const landing = landVoice(output);
    const exactness = exactnessNote(landing, mode);
    setReview(null);
    if (!exactness) {
      onClose();
      return;
    }
    // The sanitised note was already shown in the review; repeating it after
    // the landing would say the same thing twice in two places.
    setNotes({ exactness, sanitised: null });
  }

  const probed = stemModel !== null && (!voice || speakerModel !== null);
  const modelsReady = stemModel?.downloaded === true && (!voice || speakerModel?.downloaded === true);
  const modelMissing = probed && !modelsReady;
  const canSeparate = !busy && notes === null && review === null && doc !== null && length > 0 && modelsReady;
  const message = error ?? (doc === null ? 'No document is open.' : null);

  // D5: the pre-run estimate sums stage 1 (Demucs, 1/1.52 x realtime) and the
  // WHOLE of stage 2 — which D1 defines as segmentation AND embedding, so both
  // measured seeds belong in it. The embedding seed is 55 ms per audio second
  // against segmentation's 8 (`diarizeService`), so an estimate carrying only
  // the segmentation half would drop seven eighths of the stage and understate
  // a 15-minute source by ~50 s against the 7 s it did include. Stage 3 —
  // clustering and assembly, in this renderer — is named rather than numbered
  // because it has no measured seed at all; the widest measured spread in the
  // sum is the EMBEDDING's own (29-73 ms per audio second across the four
  // spike recordings), which is why the sentence promises "a short pass"
  // rather than a second number.
  const audioSeconds = doc ? length / doc.sampleRate : 0;
  const estimateSeconds =
    audioSeconds / MEASURED_REALTIME_FACTOR +
    (voice ? (audioSeconds * (MEASURED_SEGMENT_MS_PER_S + MEASURED_EMBED_MS_PER_S)) / 1000 : 0);
  const remaining = progress?.estimatedRemainingMs ?? null;

  const speakerCount = review?.diarization.speakerCount ?? 0;
  const hasEvidence = (review?.evidence.embeddings.length ?? 0) > 0;
  const documentBytes = review ? speakerDocumentBytes(review.output) : 0;
  const landingBytes = documentBytes * speakerCount;
  const overBudget = speakerCount >= 2 && landingBytes > SPEAKER_LANDING_BUDGET_BYTES;
  const totalSpeech = review ? review.diarization.speechSeconds.reduce((sum, s) => sum + s, 0) : 0;
  // The select must always show a value it actually offers: with no evidence
  // there is no count, and the disabled control still has to read as something.
  const selectValue = String(review?.requested ?? Math.max(1, speakerCount));
  const selectMax = Math.max(MAX_SPEAKERS, speakerCount);
  // D5 puts the sanitised-samples note in the REVIEW, because the count it has
  // to reason about is only settled there.
  const reviewSanitised = review ? sanitisedNote(review.output, mode, speakerCount) : null;

  return (
    <DialogShell
      title={voice ? 'Separate Voice' : 'Separate into Stems'}
      subtitle={doc ? `${doc.name} · ${formatMmss(length, doc.sampleRate)}` : undefined}
      icon={voice ? <Mic size={15} /> : <Layers size={15} />}
      width={480}
      onClose={onClose}
      dismissable={!busy}
    >
      <div className="flex flex-col gap-3" data-testid="separate-dialog">
        {review === null && (
          <>
            <SectionLabel>What you get</SectionLabel>

            <p data-testid="separate-produces" className="text-xs" style={{ color: 'var(--glass-text-label)' }}>
              {voice
                ? 'One track per speaker plus Backing. The voice is separated from everything else first, then each speaker’s turns land on their own track.'
                : `Five tracks in a new multitrack session: ${TRACK_LIST} — the Residual holding everything the model could not place.`}
            </p>

            {voice ? (
              <p
                data-testid="separate-guarantees"
                className="text-xs"
                style={{ color: 'var(--glass-text-secondary)' }}
              >
                Backing adds back to your original as before. Speaker tracks carry that speaker’s turns
                with short fades at each edge, so they do not add back sample for sample.
              </p>
            ) : (
              <p
                data-testid="separate-guarantees"
                className="text-xs"
                style={{ color: 'var(--glass-text-secondary)' }}
              >
                The five tracks always add back up to your original, sample for sample — no audio is lost.
                How cleanly the instruments are told apart is bounded by the model, so expect some bleed
                between them; that is a limit of the separation, not a bug.
              </p>
            )}
          </>
        )}

        {modelMissing && (
          <div data-testid="separate-model-missing" className="flex flex-col gap-2">
            <SectionLabel>{voice ? 'Models' : 'Model'}</SectionLabel>
            {voice ? (
              <>
                <p className="text-xs" style={{ color: 'var(--glass-text-label)' }}>
                  Separating speakers needs two model sets — one-time downloads, kept with the app’s
                  settings and reused for every later run. Both are listed so the whole bill is visible,
                  not just the unpaid half.
                </p>
                <p
                  data-testid="separate-model-line-stems"
                  className="text-xs"
                  style={{ color: 'var(--glass-text-muted)' }}
                >
                  {`The voice separation model (HT-Demucs) — ${formatModelSize(stemExpected)} · ${
                    stemModel?.downloaded ? 'already here' : 'needed'
                  }`}
                </p>
                <p
                  data-testid="separate-model-line-speakers"
                  className="text-xs"
                  style={{ color: 'var(--glass-text-muted)' }}
                >
                  {`The speaker models (segmentation + voice comparison) — ${formatModelSize(
                    speakerExpected
                  )} · ${speakerModel?.downloaded ? 'already here' : 'needed'}`}
                </p>
              </>
            ) : (
              <p className="text-xs" style={{ color: 'var(--glass-text-label)' }}>
                {`Separation needs the HT-Demucs model — a ${formatMb(
                  stemExpected
                )} one-time download, kept with the app's settings and reused for every later separation.`}
              </p>
            )}
            {downloading ? (
              <div>
                <p
                  data-testid="separate-download-status"
                  className="mb-1 text-xs"
                  style={{ color: 'var(--glass-text-muted)' }}
                >
                  {voice
                    ? `Downloading the ${
                        downloadingSet === 'speakers' ? 'speaker models' : 'voice separation model'
                      }… ${formatMb(downloadedBase + received)} of ${formatMb(downloadTotal)}`
                    : `Downloading… ${formatMb(downloadedBase + received)} of ${formatMb(downloadTotal)}`}
                </p>
                <ProgressTrack
                  testId="separate-download-progress"
                  fraction={downloadTotal > 0 ? (downloadedBase + received) / downloadTotal : 0}
                />
              </div>
            ) : (
              <div>
                <GlassButton variant="primary" onClick={() => void handleDownload()}>
                  {voice ? 'Download Models' : 'Download Model'}
                </GlassButton>
              </div>
            )}
          </div>
        )}

        {!modelMissing && !running && notes === null && review === null && (
          <p data-testid="separate-estimate" className="text-xs" style={{ color: 'var(--glass-text-muted)' }}>
            {`Runs on the CPU at about ${MEASURED_REALTIME_FACTOR.toFixed(
              1
            )}x realtime — roughly ${formatSeconds(estimateSeconds)} for this document${
              voice ? ', plus a short pass to tell the voices apart.' : '.'
            }`}
          </p>
        )}

        {running && (
          <div>
            <p
              data-testid="separate-progress-label"
              className="mb-1 text-xs"
              style={{ color: 'var(--glass-text-muted)' }}
            >
              {stage === 'diarizing' ? speakerLabel : runLabel(progress, remaining)}
            </p>
            <ProgressTrack
              testId="separate-progress"
              fraction={voice ? overall : (progress?.fraction ?? 0)}
            />
          </div>
        )}

        {review && (
          <div data-testid="speaker-review" className="flex flex-col gap-2">
            <SectionLabel>What was found</SectionLabel>
            <p
              data-testid="speaker-review-headline"
              className="text-xs font-semibold"
              style={{ color: 'var(--glass-text-title)' }}
            >
              {reviewHeadline(speakerCount, review.requested, hasEvidence)}
            </p>

            {review.diarization.speechSeconds.map((seconds, index) => (
              <p
                key={index}
                data-testid={`speaker-review-row-${index + 1}`}
                className="text-xs"
                style={{ color: 'var(--glass-text-label)' }}
              >
                {`Speaker ${index + 1} — ${formatSeconds(seconds)} of speech · ${
                  totalSpeech > 0 ? Math.round((seconds / totalSpeech) * 100) : 0
                }% of what was placed`}
              </p>
            ))}

            <label className="flex items-center gap-2 text-xs" style={{ color: 'var(--glass-text-label)' }}>
              <span className="shrink-0">Speakers</span>
              <GlassSelect
                data-testid="speaker-count"
                aria-label="Number of speakers"
                value={selectValue}
                // Nothing to re-cluster with no embeddings: the select would
                // offer counts the evidence cannot produce.
                disabled={!hasEvidence}
                style={{ width: 'auto', flex: 1 }}
                onChange={(e) => handleSpeakerCount(Number(e.target.value))}
              >
                {Array.from({ length: selectMax }, (_, i) => i + 1).map((n) => (
                  <option key={n} value={String(n)}>
                    {n === 1 ? '1 speaker' : `${n} speakers`}
                  </option>
                ))}
              </GlassSelect>
            </label>

            {speakerCount >= 2 && (
              <p
                data-testid="speaker-review-size"
                className="text-xs"
                style={{ color: 'var(--glass-text-muted)' }}
              >
                {`Each speaker track is a full-length copy of the voice — ${formatBytes(
                  documentBytes
                )}; ${speakerCount} of them need ${formatBytes(landingBytes)} of memory.`}
              </p>
            )}

            {reviewSanitised && (
              <p
                data-testid="separate-note-sanitised"
                className="text-xs"
                style={{ color: 'var(--glass-text-secondary)' }}
              >
                {reviewSanitised}
              </p>
            )}

            {overBudget && (
              <p data-testid="speaker-review-budget" className="text-xs text-[#e0a458]">
                {`These ${speakerCount} speaker tracks would need ${formatBytes(
                  landingBytes
                )}; pick fewer speakers or trim the source.`}
              </p>
            )}

            <p
              data-testid="speaker-review-limits"
              className="text-xs"
              style={{ color: 'var(--glass-text-muted)' }}
            >
              {limitsSentence()}
            </p>
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
            <GlassButton onClick={handleCancel}>Cancel</GlassButton>
          ) : (
            <>
              <GlassButton onClick={onClose} disabled={downloading}>
                Close
              </GlassButton>
              {review !== null ? (
                <GlassButton variant="primary" onClick={handleLand} disabled={overBudget}>
                  {speakerCount >= 2 ? `Land ${speakerCount} speakers + Backing` : 'Land Voice + Backing'}
                </GlassButton>
              ) : (
                !modelMissing &&
                notes === null && (
                  <GlassButton variant="primary" onClick={() => void handleSeparate()} disabled={!canSeparate}>
                    Separate
                  </GlassButton>
                )
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
 * D5's stage-2 and stage-3 labels, in the `coverJourney` voice: what the app is
 * doing, and how far into it.
 *
 * `clustering` returns NULL rather than a label of its own, and that is the
 * point of the null: D5 puts the assembly "behind the last label after a
 * yield", so the line the user is reading when the main thread goes quiet is
 * the embedding count it was already reading — not a new sentence that appears
 * for one frame and is replaced by the review panel.
 */
function speakerStageLabel(p: DiarizeProgress): string | null {
  const eta = ` · ${formatSeconds(p.estimatedRemainingMs / 1000)} left`;
  switch (p.phase) {
    case 'resampling':
      // No window count exists yet, and claiming one would be a number the
      // host has not produced.
      return LISTENING_LABEL;
    case 'segmenting':
      return `Listening for speakers — window ${p.done} of ${p.total}${eta}`;
    case 'embedding':
      return `Comparing voices — ${p.done} of ${p.total}${eta}`;
    case 'clustering':
      return null;
  }
}

/**
 * D5's review headline. Three shapes, and the third is the one that matters:
 * when the user asked for K and the share floor kept only N, saying "Found N"
 * would silently overrule them and saying "Found K" would be false.
 */
function reviewHeadline(count: number, requested: number | null, hasEvidence: boolean): string {
  if (!hasEvidence) return 'No distinct speakers were found — the voice will land as one track.';
  if (requested !== null && requested !== count) {
    return `Asked for ${requested} — ${count} had enough speech to keep.`;
  }
  if (count <= 1) return 'Found one voice.';
  return `Found ${count} speakers.`;
}

/**
 * The exactness verdict a finished landing may have to admit — post-hoc,
 * because it is `landStems`/`landVoice`'s own measurement of the source.
 *
 * `exactSumHolds === null` means the check could not be made (S5's contract) —
 * and it is also what `landSpeakers` always returns, because a speaker split is
 * not a partition of the source (D4). Silence is the honest rendering of
 * both: not a claim in either direction.
 */
function exactnessNote(landing: StemLandingResult, mode: SeparateMode): string | null {
  if (landing.exactSumHolds !== false) return null;
  const voice = mode === 'voice';
  const clamped = `This document peaks above full scale (${(landing.sourcePeak ?? 0).toFixed(
    2
  )}), so the multitrack master clamps at ±1 and the ${
    voice ? 'two' : 'five'
  } tracks will not add back to it exactly.`;
  return voice
    ? `${clamped} The Voice and the Backing themselves are complete — reduce the source level and separate again if you need them to add back up.`
    : `${clamped} The stems themselves are complete — reduce the source level and separate again if you need the exact sum.`;
}

/**
 * The other post-hoc admission: how many non-finite model samples were zeroed.
 * Only known after inference, so it is shown in the review step (D5) rather
 * than before the run.
 *
 * `speakerCount` decides which sum sentence is true, and null means "not a
 * speaker landing at all". D4: the two-track identity belongs to Voice +
 * Backing; a split across two or more speakers has edge fades and shared
 * overlap regions, so the claim is dropped rather than repeated.
 */
function sanitisedNote(
  output: StemSeparationOutput,
  mode: SeparateMode,
  speakerCount: number | null
): string | null {
  if (output.sanitisedEstimateSamples <= 0) return null;
  const head = `The model returned ${output.sanitisedEstimateSamples} non-finite value(s), which were zeroed;`;
  // D4: the Residual is not a track of its own in voice mode — it is summed
  // into the Backing — so naming it would send the user looking for a lane
  // that is not in the session.
  if (mode !== 'voice') {
    return `${head} that energy went to the Residual track. The sum is still exact — only the separation around those samples is less clean.`;
  }
  if (speakerCount !== null && speakerCount >= 2) {
    return `${head} that energy went to the Backing. Only the separation around those samples is less clean.`;
  }
  return `${head} that energy went to the Backing. The two tracks still add back up — only the separation around those samples is less clean.`;
}
