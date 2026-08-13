import { useEffect, useRef, useState } from 'react';
import { Mic2 } from 'lucide-react';
import { docLength } from '../../audio/AudioDocument';
import { useAppStore } from '../../stores/appStore';
import {
  COVER_CHAIN_CONFIRM_SENTENCE,
  COVER_CHAIN_GOOD_TAKE_SENTENCE,
  COVER_CHAIN_RESIDUAL_SENTENCE,
  COVER_CHAIN_SHAPING_SENTENCE,
  COVER_CHAIN_SPREAD_SENTENCE,
} from '../../services/coverChain';
import {
  COVER_JOURNEY_STAGES,
  runCoverJourney,
  type CoverJourneyReport,
  type CoverJourneyStageId,
  type CoverJourneyStageProgress,
  type CoverJourneyStageResult,
  type CoverJourneyStageStatus,
} from '../../services/coverJourney';
import type { DerivedValue, StageStatus } from '../../services/vocalChain';
import { GlassButton, SectionLabel } from '../UI/glass';
import DialogShell from './DialogShell';

const AMBER = '#e0a458';
const secs = (samples: number, rate: number): string => `${(samples / rate).toFixed(2)} s`;

/** What each journey status SAYS, in words a user can act on. */
const STATUS_TEXT: Record<CoverJourneyStageStatus, string> = {
  done: '✓ Done',
  declined: 'Did not run',
  reused: '✓ Reused',
  cancelled: 'Cancelled',
  failed: 'Failed',
  pending: 'Waiting',
};

const STATUS_COLOR: Record<CoverJourneyStageStatus, string> = {
  done: 'var(--accent)',
  // Amber, the colour every other dialog uses for "read this": a declined stage
  // is the one outcome that is easy to mistake for a successful one.
  declined: AMBER,
  reused: 'var(--accent)',
  cancelled: AMBER,
  failed: '#ef5350',
  pending: 'var(--glass-text-muted)',
};

/** The nested chains' four statuses, in the same words the chain dialogs use. */
const SUB_STATUS_TEXT: Record<StageStatus, string> = {
  applied: 'Ran',
  declined: 'Did not run',
  off: 'Switched off',
  manual: 'Manual step',
};

const SUB_STATUS_COLOR: Record<StageStatus, string> = {
  applied: 'var(--accent)',
  declined: AMBER,
  off: 'var(--glass-text-muted)',
  manual: 'var(--glass-text-muted)',
};

/**
 * One row of a NESTED chain — the Vocal Chain's eleven stages, or the Cover
 * Chain's nine.
 *
 * Typed on the structural subset both `VocalChainStageResult` and
 * `CoverChainStageResult` share rather than on either of them, because the two
 * are the same shape for everything shown here and a second renderer could only
 * describe the same fields in different words. What is deliberately NOT shown
 * is each chain's own before/after table and the Cover Chain's per-band curve:
 * those live in the chains' own dialogs, and a journey report that reproduced
 * them would be four tables deep.
 */
interface NestedStage {
  id: string;
  label: string;
  status: StageStatus;
  reason?: string;
  warning?: string;
  derived: DerivedValue[];
  detail?: string;
}

function NestedStages({ parentId, stages }: { parentId: string; stages: readonly NestedStage[] }) {
  return (
    <div
      data-testid={`cover-journey-nested-${parentId}`}
      className="mt-2 flex flex-col gap-1"
      style={{ borderLeft: '2px solid var(--glass-border)', paddingLeft: 8 }}
    >
      {stages.map((s) => (
        <div key={s.id} data-testid={`cover-journey-nested-${parentId}-${s.id}`}>
          <div className="flex items-baseline justify-between gap-2">
            <span className="text-xs" style={{ color: 'var(--glass-text-label)' }}>
              {s.label}
            </span>
            <span className="shrink-0 text-xs" style={{ color: SUB_STATUS_COLOR[s.status] }}>
              {SUB_STATUS_TEXT[s.status]}
            </span>
          </div>
          {s.status === 'declined' && s.reason && (
            <p className="text-xs" style={{ color: AMBER }}>
              {s.reason}
            </p>
          )}
          {s.warning && (
            <p className="text-xs" style={{ color: AMBER }}>
              Warning — {s.warning}
            </p>
          )}
          {s.derived.map((d) => (
            <p key={d.label} className="text-xs" style={{ color: 'var(--glass-text-muted)' }}>
              <span className="font-mono">
                {d.label}: {d.value}
              </span>
            </p>
          ))}
          {s.detail && (
            <p className="text-xs" style={{ color: 'var(--glass-text-muted)' }}>
              {s.detail}
            </p>
          )}
        </div>
      ))}
    </div>
  );
}

/** What one journey stage decided, under that stage's own row. */
function StageResult({ result }: { result: CoverJourneyStageResult }) {
  const nested: NestedStage[] | null = result.vocalChain
    ? result.vocalChain.stages
    : result.coverChain
      ? result.coverChain.stages
      : null;
  return (
    <div className="mt-1 flex flex-col gap-0.5">
      {result.reason && (
        <p
          data-testid={`cover-journey-reason-${result.id}`}
          className="text-xs"
          style={{ color: result.status === 'failed' ? '#ef5350' : AMBER }}
        >
          {STATUS_TEXT[result.status]} — {result.reason}
        </p>
      )}
      {result.warning && (
        <p data-testid={`cover-journey-warning-${result.id}`} className="text-xs" style={{ color: AMBER }}>
          Warning — {result.warning}
        </p>
      )}
      {result.derived.map((d) => (
        <p
          key={d.label}
          data-testid={`cover-journey-derived-${result.id}`}
          className="text-xs"
          style={{ color: 'var(--glass-text-label)' }}
        >
          <span className="font-mono">
            {d.label}: {d.value}
          </span>
          <span style={{ color: 'var(--glass-text-muted)' }}> — from {d.from}</span>
        </p>
      ))}
      {nested && nested.length > 0 && <NestedStages parentId={result.id} stages={nested} />}
    </div>
  );
}

/**
 * CP1 — the Cover Chain, as the whole journey.
 *
 * Two inputs at the top (the original song, and the take), six automatic stages
 * as the body, and nothing left for the user to wire up in between. What was
 * five documented manual steps is now two automated passes, one automated
 * placement, an automated session and an automated smoothing — with Align
 * Lyrics the one genuinely manual pre-step that remains, listed with its reason.
 *
 * The honesty block still sits ABOVE the button rather than in a footnote, and
 * for the same reason it did before: the instrumental a cover is laid over still
 * contains the original singer, the match is a gentle shaping rather than a
 * transformation, and a single take still has to be a good take. A user who
 * reads those after pressing Run has been told too late. Two sentences are new,
 * and both describe things the run itself does: the alignment is a PLACEMENT
 * rather than a warp, and cancelling before the session is built leaves
 * documents and no session.
 */
export default function CoverChainDialog({ onClose }: { onClose: () => void }) {
  const documents = useAppStore((s) => s.documents);
  const activeId = useAppStore((s) => s.activeDocumentId);

  // The take defaults to whatever is in front of the user; the song does not
  // default at all, because picking the wrong one costs a separation.
  const [takeDocId, setTakeDocId] = useState<string>(activeId ?? '');
  const [songDocId, setSongDocId] = useState<string>('');
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [running, setRunning] = useState<string | null>(null);
  const [report, setReport] = useState<CoverJourneyReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [liveResults, setLiveResults] = useState<CoverJourneyStageResult[]>([]);
  const [stageProgress, setStageProgress] = useState<CoverJourneyStageProgress | null>(null);

  // Two separate flags. `cancelledRef` is the UNMOUNT guard (RemixDialog's
  // idiom — the cleanup must read the current value, so a ref rather than
  // state); `cancelRequestedRef` is the user pressing Cancel, which the engine
  // polls between stages. They are not the same event and conflating them would
  // make closing the dialog silently abort a run that was still wanted.
  const cancelledRef = useRef(false);
  const cancelRequestedRef = useRef(false);
  const [cancelRequested, setCancelRequested] = useState(false);
  useEffect(() => {
    cancelledRef.current = false;
    return () => {
      cancelledRef.current = true;
      cancelRequestedRef.current = true;
    };
  }, []);

  const take = documents.find((d) => d.id === takeDocId) ?? null;
  const song = documents.find((d) => d.id === songDocId) ?? null;
  const ready = take !== null && song !== null && song.id !== take.id;
  const done = report !== null;
  const locked = busy || done;

  // CP1 fix-round: the finished report wins the moment it exists, and a run that
  // could not START shows NOTHING. Without the `busy` arm the rows `onStageResult`
  // had already pushed stayed on screen next to the error, looking like an
  // outcome — the exact defect the old dialog's "shows nothing from a run that
  // failed" pin existed to prevent, dropped in the rewrite.
  const resultById = new Map<CoverJourneyStageId, CoverJourneyStageResult>(
    (report ? report.stages : busy ? liveResults : []).map((r) => [r.id, r] as const)
  );

  async function handleRun(): Promise<void> {
    if (!ready || busy || done) return;
    setBusy(true);
    setProgress(0);
    setRunning(null);
    setError(null);
    setReport(null);
    setLiveResults([]);
    setStageProgress(null);
    cancelRequestedRef.current = false;
    setCancelRequested(false);
    try {
      const result = await runCoverJourney({
        songDocId,
        takeDocId,
        shouldCancel: () => cancelRequestedRef.current,
        onProgress: (f) => {
          if (!cancelledRef.current) setProgress(f);
        },
        onStageStart: (stage) => {
          if (!cancelledRef.current) setRunning(stage.label);
        },
        onStageProgress: (p) => {
          if (!cancelledRef.current) setStageProgress(p);
        },
        onStageResult: (r) => {
          if (!cancelledRef.current) setLiveResults((prev) => [...prev, r]);
        },
      });
      if (cancelledRef.current) return;
      if (!result) {
        setError(
          'The pass could not start. Choose an original song and a vocal take — two different documents, both with audio in them.'
        );
      } else {
        setReport(result);
      }
    } finally {
      if (!cancelledRef.current) {
        setBusy(false);
        setRunning(null);
        setStageProgress(null);
      }
    }
  }

  return (
    <DialogShell
      title="Cover Chain"
      subtitle={song && take ? `${take.name} over ${song.name}` : 'the whole journey'}
      icon={<Mic2 size={15} />}
      // M4 (the train's width ruling): 640, not the 680 the journey rewrite
      // arrived with. 640 is not this dialog's taste — it is the widest width
      // any of the nine hosted tools asks for, and U2's PipelineToolHost reads
      // these nine sources to derive TOOL_HOST_WIDTH from them, so raising it
      // here widens the host card for every tool and costs the stage 40 px at
      // every window size. The rewrite had no content asking for the extra 40:
      // the two multi-column tables that made this the widest dialog in the
      // first place (the per-band EQ curve and the before/after summary) were
      // REMOVED by that same rewrite, and everything left is a vertical stack
      // of flowing text, flex rows and full-width bars with no fixed-width
      // content in it. The 680 was incidental — nothing in the commit that
      // introduced it, or in its call site, ever justified it.
      width={640}
      onClose={onClose}
      dismissable={!busy}
    >
      <div className="flex flex-col gap-3" data-testid="cover-chain-dialog">
        <p data-testid="cover-journey-intro" className="text-xs" style={{ color: 'var(--glass-text-label)' }}>
          Give it the original song and your vocal take. It separates the original, cleans your take with the
          Vocal Chain, finds where your take belongs against the original vocal, matches its tone and level to
          that vocal, builds a session with the original&rsquo;s music and your take on it, and smooths the
          edges. Every stage reports what it measured; nothing runs that you cannot read afterwards.
        </p>

        <SectionLabel>Before you run this</SectionLabel>

        <p data-testid="cover-chain-limitation" className="text-xs" style={{ color: AMBER }}>
          {COVER_CHAIN_RESIDUAL_SENTENCE}
        </p>
        <p data-testid="cover-chain-shaping" className="text-xs" style={{ color: 'var(--glass-text-label)' }}>
          {COVER_CHAIN_SHAPING_SENTENCE}
        </p>
        <p data-testid="cover-chain-good-take" className="text-xs" style={{ color: 'var(--glass-text-label)' }}>
          {COVER_CHAIN_GOOD_TAKE_SENTENCE}
        </p>
        <p data-testid="cover-journey-placement-note" className="text-xs" style={{ color: 'var(--glass-text-label)' }}>
          The alignment is a PLACEMENT, not a warp: your whole take is moved by one offset, and a take that
          drifts against the original still drifts. {COVER_CHAIN_CONFIRM_SENTENCE} Align Vocal Timing and Align
          Lyrics stay manual for that reason, and are worth running afterwards — Align Lyrics before a second
          pass, so the replaced word is in the file before any stage measures a level from it.
        </p>
        <p data-testid="cover-journey-cancel-note" className="text-xs" style={{ color: 'var(--glass-text-muted)' }}>
          The run takes minutes and the separation is most of it. Cancel works between stages. The session is
          built only at stage 5, so cancelling before then leaves you with the documents this pass produced —
          the stems, and your take with whatever passes had already finished — and no session.
        </p>

        <SectionLabel>What to run it on</SectionLabel>

        <label className="flex items-center gap-2 text-xs" style={{ color: 'var(--glass-text-label)' }}>
          <span className="w-28 shrink-0">Original song</span>
          <select
            data-testid="cover-journey-song"
            className="min-w-0 flex-1 rounded-lg px-2 py-1 text-xs"
            style={{
              // MT1-4: opaque, not the 5%-white tint. This picker is the
              // reported repro — its native popup is painted with this
              // background off the glass surface, where a tint composites to
              // near-white under light-gray option text.
              background: 'var(--glass-field-bg)',
              border: '1px solid var(--glass-border)',
              color: 'var(--glass-text-title)',
            }}
            value={songDocId}
            disabled={locked}
            onChange={(e) => setSongDocId(e.target.value)}
          >
            <option value="">— choose the full mix —</option>
            {documents
              .filter((d) => d.id !== takeDocId)
              .map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
          </select>
        </label>

        <label className="flex items-center gap-2 text-xs" style={{ color: 'var(--glass-text-label)' }}>
          <span className="w-28 shrink-0">Your vocal take</span>
          <select
            data-testid="cover-journey-take"
            className="min-w-0 flex-1 rounded-lg px-2 py-1 text-xs"
            style={{
              // MT1-4: opaque, for the same reason as the picker above. This
              // one is new in the journey rewrite, so it never carried the
              // original fix — a tint here composites to near-white in the
              // native popup under light-gray option text.
              background: 'var(--glass-field-bg)',
              border: '1px solid var(--glass-border)',
              color: 'var(--glass-text-title)',
            }}
            value={takeDocId}
            disabled={locked}
            onChange={(e) => setTakeDocId(e.target.value)}
          >
            <option value="">— choose your take —</option>
            {documents
              .filter((d) => d.id !== songDocId)
              .map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
          </select>
        </label>

        {take && (
          <p data-testid="cover-journey-scope" className="text-xs" style={{ color: 'var(--glass-text-muted)' }}>
            The whole take runs, not a selection — {secs(docLength(take), take.sampleRate)}
            {song ? ` against ${secs(docLength(song), song.sampleRate)} of song` : ''}.
          </p>
        )}

        {!ready && !busy && (
          <p data-testid="cover-journey-not-ready" className="text-xs" style={{ color: AMBER }}>
            Choose two different documents: the original song (the full mix — this pass separates it for you)
            and your vocal take.
          </p>
        )}

        <SectionLabel>The journey</SectionLabel>

        <div className="flex flex-col gap-2">
          {COVER_JOURNEY_STAGES.map((stage) => {
            const result = resultById.get(stage.id);
            const isRunning = busy && !result && stageProgress?.stageId === stage.id;
            const status: CoverJourneyStageStatus | null = result ? result.status : null;
            const activity = isRunning ? stageProgress : null;
            return (
              <div
                key={stage.id}
                data-testid={`cover-journey-stage-${stage.id}`}
                data-state={result ? result.status : isRunning ? 'running' : 'idle'}
                className="rounded-xl"
                style={{
                  border: `1px solid ${isRunning ? 'var(--accent)' : 'var(--glass-border)'}`,
                  background: isRunning ? 'var(--accent-ring)' : 'rgba(255, 255, 255, 0.02)',
                  padding: '8px 10px',
                  opacity: busy && !result && !isRunning ? 0.55 : 1,
                }}
              >
                <div className="flex items-baseline justify-between gap-2">
                  <span className="text-xs font-semibold" style={{ color: 'var(--glass-text-title)' }}>
                    {stage.label}
                  </span>
                  <span
                    data-testid={`cover-journey-status-${stage.id}`}
                    className="shrink-0 text-xs"
                    style={{ color: status ? STATUS_COLOR[status] : 'var(--accent)' }}
                  >
                    {status
                      ? STATUS_TEXT[status]
                      : isRunning
                        ? `Running · ${Math.round((activity?.stageFraction ?? 0) * 100)}%`
                        : ''}
                    {result?.elapsedMs !== undefined ? ` · ${(result.elapsedMs / 1000).toFixed(1)} s` : ''}
                  </span>
                </div>
                <p
                  data-testid={`cover-journey-note-${stage.id}`}
                  className="mt-1 text-xs"
                  style={{ color: 'var(--glass-text-muted)' }}
                >
                  {stage.note}
                </p>
                {activity && (
                  <div className="mt-1 flex flex-col gap-1">
                    <p
                      data-testid={`cover-journey-activity-${stage.id}`}
                      className="text-xs"
                      style={{ color: 'var(--glass-text-label)' }}
                    >
                      {activity.detail}
                    </p>
                    {/* The nested chain's OWN row, never flattened into the line
                        above: ten vocal-chain stages behind one bar is exactly
                        what the live view exists to stop. */}
                    {activity.sub && (
                      <p
                        data-testid={`cover-journey-sub-${stage.id}`}
                        className="text-xs"
                        style={{ color: 'var(--glass-text-muted)' }}
                      >
                        {activity.sub.label} — {activity.sub.detail} ·{' '}
                        {Math.round(activity.sub.stageFraction * 100)}%
                      </p>
                    )}
                    <div
                      className="h-1 w-full overflow-hidden rounded-full"
                      style={{ background: 'rgba(255, 255, 255, 0.09)' }}
                    >
                      <div
                        data-testid={`cover-journey-stage-progress-${stage.id}`}
                        className="h-full transition-[width]"
                        style={{
                          width: `${Math.round((activity.stageFraction ?? 0) * 100)}%`,
                          background: 'var(--accent)',
                        }}
                      />
                    </div>
                  </div>
                )}
                {result && <StageResult result={result} />}
              </div>
            );
          })}
        </div>

        {report && (
          <>
            <SectionLabel>What you have now</SectionLabel>
            <p data-testid="cover-journey-outcome" className="text-xs" style={{ color: 'var(--glass-text-label)' }}>
              {report.completed
                ? `“${report.placement?.sessionName}” is open in the multitrack view: the original’s music on one track, your take on the other. Press play, or Mix Down to render it. The whole pass took ${(report.elapsedMs / 1000).toFixed(1)} s.`
                : report.cancelledAt
                  ? `Cancelled at “${COVER_JOURNEY_STAGES.find((s) => s.id === report.cancelledAt)?.label}”. Every stage above says what it did before it stopped.`
                  : 'The pass stopped early. The stage that failed says why above.'}
            </p>
            <p data-testid="cover-journey-undo" className="text-xs" style={{ color: 'var(--glass-text-muted)' }}>
              {report.undoEntries.length > 0
                ? `Undo entries left on your take, newest last: ${report.undoEntries.map((e) => `“${e}”`).join(', ')}. Each pass keeps its own entry — there is deliberately no single entry that undoes the whole journey, because an undo entry belongs to one document and this pass touched two documents and a session.`
                : 'No pass changed your take, so there is nothing to undo.'}
            </p>
            <p data-testid="cover-chain-spread-note" className="text-xs" style={{ color: 'var(--glass-text-muted)' }}>
              {COVER_CHAIN_SPREAD_SENTENCE}
            </p>
          </>
        )}

        {error && (
          <p data-testid="cover-journey-error" className="text-xs text-[#ef5350]">
            {error}
          </p>
        )}

        {busy && (
          <div>
            <p data-testid="cover-journey-running" className="mb-1 text-xs" style={{ color: 'var(--glass-text-muted)' }}>
              {cancelRequested
                ? 'Stopping after this stage…'
                : running
                  ? `Whole journey — running ${running}…`
                  : 'Whole journey — starting…'}
            </p>
            <div
              className="h-1.5 w-full overflow-hidden rounded-full"
              style={{
                background: 'rgba(255, 255, 255, 0.09)',
                boxShadow: 'inset 0 1px 2px rgba(0, 0, 0, 0.6)',
              }}
            >
              <div
                data-testid="cover-journey-progress"
                className="h-full transition-[width]"
                style={{
                  width: `${Math.round(progress * 100)}%`,
                  background: 'var(--accent)',
                  boxShadow: '0 0 8px var(--accent-ring)',
                }}
              />
            </div>
          </div>
        )}

        <div className="mt-2 flex justify-end gap-2">
          {done ? (
            <GlassButton variant="primary" data-testid="cover-chain-close" onClick={onClose}>
              Close
            </GlassButton>
          ) : busy ? (
            <GlassButton
              data-testid="cover-journey-stop"
              disabled={cancelRequested}
              onClick={() => {
                cancelRequestedRef.current = true;
                setCancelRequested(true);
              }}
            >
              {cancelRequested ? 'Stopping…' : 'Cancel the run'}
            </GlassButton>
          ) : (
            <>
              <GlassButton data-testid="cover-chain-cancel" onClick={onClose}>
                Close
              </GlassButton>
              <GlassButton
                variant="primary"
                data-testid="cover-chain-apply"
                onClick={() => void handleRun()}
                disabled={!ready}
              >
                Run the journey
              </GlassButton>
            </>
          )}
        </div>
      </div>
    </DialogShell>
  );
}
