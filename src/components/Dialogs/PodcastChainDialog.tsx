import { useEffect, useRef, useState } from 'react';
import { Podcast } from 'lucide-react';
import { docLength } from '../../audio/AudioDocument';
import type { StageDelta } from '../../dsp/chainAnalysis';
import { useAppStore } from '../../stores/appStore';
import {
  PODCAST_CHAIN_MAX_CHANNELS,
  PODCAST_CHAIN_STAGES,
  PODCAST_CHAIN_UNDO_LABEL,
  PODCAST_CHANNEL_REFUSAL,
  PODCAST_TARGET_LUFS_MONO,
  PODCAST_TARGET_LUFS_STEREO,
  defaultPodcastStageSelection,
  runPodcastChain,
  type PodcastChainMetrics,
  type PodcastChainReport,
  type PodcastChainStageId,
  type PodcastChainStageProgress,
  type PodcastChainStageResult,
} from '../../services/podcastChain';
import type { ChainStagePhase, StageStatus } from '../../services/vocalChain';
import { GlassButton, SectionLabel } from '../UI/glass';
import DialogShell from './DialogShell';

const dbfs = (v: number): string => (Number.isFinite(v) ? `${v.toFixed(1)} dBFS` : '—');
const db = (v: number): string => (Number.isFinite(v) ? `${v.toFixed(1)} dB` : '—');
const lufs = (v: number): string => (Number.isFinite(v) ? `${v.toFixed(1)} LUFS` : '—');
const pct = (v: number): string => `${(v * 100).toFixed(1)}%`;
const secs = (samples: number, rate: number): string => `${(samples / rate).toFixed(2)} s`;

/** What each status SAYS, in the words a user can act on. `applied` claims only
 * that the stage ran — how well it ran is what the measured delta below it is
 * for, and is not something this dialog is in a position to grade.
 *
 * `manual` is in the map because `StageStatus` is shared with the vocal and
 * cover chains, and this chain never produces it: every podcast stage runs
 * unattended. It is carried rather than dropped so a total map cannot render a
 * blank if that ever changes. */
const STATUS_TEXT: Record<StageStatus, string> = {
  applied: 'Ran',
  declined: 'Did not run',
  off: 'Switched off',
  manual: 'Manual step',
};

const STATUS_COLOR: Record<StageStatus, string> = {
  applied: 'var(--accent)',
  // Amber, the same colour every other dialog uses for "read this": a declined
  // stage is the one outcome that is easy to mistake for a successful one.
  declined: '#e0a458',
  off: 'var(--glass-text-muted)',
  manual: 'var(--glass-text-muted)',
};

type StepState = 'done' | 'declined' | 'running' | 'pending' | 'off' | 'manual';

const STEP_TEXT: Record<StepState, string> = {
  done: STATUS_TEXT.applied,
  declined: STATUS_TEXT.declined,
  running: 'Running',
  pending: 'Waiting',
  off: STATUS_TEXT.off,
  manual: STATUS_TEXT.manual,
};

const STEP_COLOR: Record<StepState, string> = {
  done: STATUS_COLOR.applied,
  declined: STATUS_COLOR.declined,
  running: 'var(--accent)',
  pending: 'var(--glass-text-muted)',
  off: STATUS_COLOR.off,
  manual: STATUS_COLOR.manual,
};

const STEP_OF_STATUS: Record<StageStatus, StepState> = {
  applied: 'done',
  declined: 'declined',
  off: 'off',
  manual: 'manual',
};

/** What the phase is called on screen. The engine's own two words, capitalised
 * — the sentence after the em-dash is the engine's detail verbatim. */
const PHASE_TEXT: Record<ChainStagePhase, string> = {
  measuring: 'Measuring',
  rendering: 'Rendering',
};

/**
 * The four numbers the report carries before and after.
 *
 * `Peak (sample)` is labelled, not decorated: `LimiterEffect` is not
 * oversampled, so this is a sample-peak reading and never a true-peak/dBTP one.
 * Naming the reading on the row is what stops the ceiling being read as
 * something the DSP does not measure.
 */
const METRIC_ROWS: { key: keyof PodcastChainMetrics; label: string; unit: 'dbfs' | 'db' | 'lufs' }[] =
  [
    { key: 'rmsDb', label: 'RMS', unit: 'dbfs' },
    { key: 'peakDb', label: 'Peak (sample)', unit: 'dbfs' },
    { key: 'crestDb', label: 'Crest', unit: 'db' },
    { key: 'lufs', label: 'Loudness', unit: 'lufs' },
  ];

/** `null` is a real answer here — nothing survived BS.1770-4's gating, or the
 * document was refused before anything was measured — and it is rendered as one
 * rather than as a zero. A loudness of 0.0 LUFS is full scale, not silence. */
function metricText(value: number | null, unit: 'dbfs' | 'db' | 'lufs'): string {
  if (value === null) return 'n/a';
  if (unit === 'lufs') return lufs(value);
  return unit === 'dbfs' ? dbfs(value) : db(value);
}

/** The four numbers every applied stage reports, in one line. `identicalFraction`
 * and `differenceRmsDb` are absent for the length-changing stage (Shorten
 * Pauses), where there is no sample-to-sample correspondence to compare — so
 * they are omitted rather than printed as 0. */
function deltaText(delta: StageDelta): string {
  const parts = [
    `RMS ${dbfs(delta.rmsBeforeDb)} → ${dbfs(delta.rmsAfterDb)}`,
    `peak ${dbfs(delta.peakBeforeDb)} → ${dbfs(delta.peakAfterDb)}`,
  ];
  if (delta.identicalFraction !== null) {
    parts.push(`${pct(delta.identicalFraction)} of samples unchanged`);
  }
  if (delta.differenceRmsDb !== null) {
    parts.push(`difference ${dbfs(delta.differenceRmsDb)}`);
  }
  return parts.join(' · ');
}

/** What one stage did, under that stage's own row: the settings it worked out
 * and what from, the measured change, and whatever the stage knows that the
 * buffers do not show. A declined stage renders its reason INSTEAD, in amber; a
 * stage that RAN but needs a caveat renders the caveat as well, in the same
 * amber, because both are "read this". */
function StageResult({ result }: { result: PodcastChainStageResult }) {
  if (result.status === 'declined') {
    return (
      <p
        data-testid={`podcast-chain-reason-${result.id}`}
        className="mt-1 text-xs"
        style={{ color: STATUS_COLOR.declined }}
      >
        Did not run — {result.reason}
      </p>
    );
  }
  if (result.status !== 'applied') return null;
  return (
    <div className="mt-1 flex flex-col gap-0.5">
      {result.warning && (
        <p
          data-testid={`podcast-chain-warning-${result.id}`}
          className="text-xs"
          style={{ color: STATUS_COLOR.declined }}
        >
          Warning — {result.warning}
        </p>
      )}
      {/* The loudness stage's own numbers. Both are MEASURED — the engine
          re-reads the result rather than asserting the target it asked for — so
          the two are allowed to differ and the row shows them separately
          instead of printing the target twice. */}
      {result.loudness && (
        <p
          data-testid={`podcast-chain-loudness-${result.id}`}
          className="font-mono text-xs"
          style={{ color: 'var(--glass-text-title)' }}
        >
          {lufs(result.loudness.beforeLufs)} →{' '}
          {result.loudness.afterLufs === null ? 'n/a' : lufs(result.loudness.afterLufs)}
          <span style={{ color: 'var(--glass-text-muted)' }}>
            {' '}
            (target {lufs(result.loudness.targetLufs)})
          </span>
        </p>
      )}
      {result.derived.map((d) => (
        <p
          key={d.label}
          data-testid={`podcast-chain-derived-${result.id}`}
          className="text-xs"
          style={{ color: 'var(--glass-text-label)' }}
        >
          <span className="font-mono">
            {d.label}: {d.value}
          </span>
          <span style={{ color: 'var(--glass-text-muted)' }}> — from {d.from}</span>
        </p>
      ))}
      {result.detail && (
        <p
          data-testid={`podcast-chain-detail-${result.id}`}
          className="text-xs"
          style={{ color: 'var(--glass-text-label)' }}
        >
          {result.detail}
        </p>
      )}
      {result.delta && (
        <p
          data-testid={`podcast-chain-delta-${result.id}`}
          className="font-mono text-xs"
          style={{ color: 'var(--glass-text-secondary)' }}
        >
          {deltaText(result.delta)}
        </p>
      )}
    </div>
  );
}

/**
 * D6 — the Podcast Chain.
 *
 * The engine (`services/podcastChain.ts`) owns the order, the derivations, the
 * loudness measurement and the single undo entry. This dialog owns one job, and
 * it is not "press go": it is to make the pass ACCOUNTABLE, before and after.
 * It is the Vocal Chain dialog's shape deliberately — a user who has run one
 * should not have to learn the other — with three differences, all of them
 * forced by what this chain is:
 *
 * 1. EVERY stage has a checkbox. In the vocal and cover chains `effectId ===
 *    null` means "manual, never runs unattended" and those rows are listed
 *    without a switch. Here it means "the chain applies this one itself", and
 *    the only such stage is `loudness` — the stage most worth being able to
 *    switch off, since it is the one that moves the delivery level. Keying the
 *    checkbox off `effectId` (which a copy of the other dialog would) would
 *    make it the one stage the user cannot refuse.
 *
 * 2. The summary carries a LOUDNESS row. It is this chain's headline: the pass
 *    exists to land -16 LUFS in stereo or -19 in mono, and a report that showed
 *    RMS and peak but not the measurement the run was steered by would be
 *    hiding its own subject. `null` renders as `n/a` — 0.0 LUFS is full scale,
 *    not silence.
 *
 * 3. A REFUSAL is a first-class outcome. The chain will not run on a document
 *    with more than two channels, because its loudness measurement is
 *    standard-accurate for mono and stereo only. That path resolves a report
 *    with no stages and CALLS NO CALLBACK — `onProgress` never fires — so this
 *    dialog treats the promise resolving as completion rather than waiting on a
 *    bar that will never move, renders the engine's own sentence (which names
 *    the fix) and offers Close rather than an Apply that could only refuse
 *    again.
 *
 * The ceiling is a SAMPLE peak everywhere in this view, and the metric row says
 * so: the limiter is not oversampled, so no reading here is a true-peak one.
 *
 * Nothing here grades the result. The numbers are stated; whether they are the
 * ones the user wanted is the user's call.
 */
export default function PodcastChainDialog({ onClose }: { onClose: () => void }) {
  const doc = useAppStore((s) => s.documents.find((d) => d.id === s.activeDocumentId) ?? null);
  const selection = useAppStore((s) => s.selection);

  const [enabled, setEnabled] =
    useState<Record<PodcastChainStageId, boolean>>(defaultPodcastStageSelection);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [running, setRunning] = useState<string | null>(null);
  const [report, setReport] = useState<PodcastChainReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The live half of the stepper. `liveResults` holds the engine's OWN result
  // objects as they land — the same ones `report.stages` will carry — and
  // `stageProgress` holds the last thing the running stage said about itself.
  const [liveResults, setLiveResults] = useState<PodcastChainStageResult[]>([]);
  const [stageProgress, setStageProgress] = useState<PodcastChainStageProgress | null>(null);

  // RemixDialog's unmount-cancel idiom: the cleanup must read the CURRENT value,
  // so a ref rather than state. Every continuation below checks it before
  // touching state, so closing the dialog mid-run unmounts cleanly. It is not a
  // kill switch — the chain owns its own worker leg and its own undo entry, and
  // a run that has started must be allowed to land or roll back as one.
  const cancelledRef = useRef(false);
  useEffect(() => {
    cancelledRef.current = false;
    return () => {
      cancelledRef.current = true;
    };
  }, []);

  if (!doc) return null;

  const rate = doc.sampleRate;
  const regionSamples = selection ? selection.end - selection.start : docLength(doc);
  const scopeText = selection
    ? `Selection — ${secs(regionSamples, rate)}`
    : `Whole file — ${secs(regionSamples, rate)}`;
  // Which target this document will be held to, from the same channel count the
  // engine reads — INCLUDING the engine's own >2-channel branch (final review,
  // C2). Stated before the run as well as after it, because it is the one number
  // the whole pass is steered by; a document the engine will refuse has no
  // target at all, and calling it "stereo" was a false description of a 6-channel
  // file on the very path D6 exists for.
  const channelCount = doc.channels.length;
  const tooManyChannels = channelCount > PODCAST_CHAIN_MAX_CHANNELS;
  const mono = channelCount === 1;
  const targetLufs = mono ? PODCAST_TARGET_LUFS_MONO : PODCAST_TARGET_LUFS_STEREO;
  /** Only a document with EXACTLY two channels is stereo (minor M21). */
  const channelWord = mono ? 'mono' : 'stereo';

  // The finished report wins the moment it exists, and a run that FAILED shows
  // nothing: `runPodcastChain` resolves null after rolling the document back,
  // and the stages that had already reported would otherwise be left on screen
  // looking like an outcome of a pass that changed nothing.
  const resultById = new Map<PodcastChainStageId, PodcastChainStageResult>(
    (report ? report.stages : busy ? liveResults : []).map((r) => [r.id, r] as const)
  );
  const anyEnabled = PODCAST_CHAIN_STAGES.some((s) => enabled[s.id]);
  const refused = report !== null && report.refusal !== null;
  const done = report !== null && report.applied;
  // Whether the LIMITER actually ran (final review, C10). Every stage has a
  // checkbox, so the delivery sentence below may not claim the limiter held the
  // peak: with the stage switched off the loudness gain leaves the peak wherever
  // it lands, and the loudness row's own warning says so a few lines above.
  const limiterApplied =
    report !== null && report.stages.find((r) => r.id === 'limiter')?.status === 'applied';
  // A refused document is as finished as an applied one: nothing the user can
  // do inside this dialog changes the channel count, so re-running could only
  // refuse a second time.
  const finished = done || refused;
  const locked = busy || finished;

  function toggle(id: PodcastChainStageId, next: boolean): void {
    setEnabled((prev) => ({ ...prev, [id]: next }));
  }

  async function handleApply(): Promise<void> {
    if (busy || finished || !anyEnabled) return;
    setBusy(true);
    setProgress(0);
    setRunning(null);
    setError(null);
    setReport(null);
    setLiveResults([]);
    setStageProgress(null);
    try {
      const result = await runPodcastChain({
        enabled,
        onProgress: (fraction) => {
          if (!cancelledRef.current) setProgress(fraction);
        },
        onStageStart: (stage) => {
          if (!cancelledRef.current) setRunning(stage.label);
        },
        onStageProgress: (p) => {
          if (!cancelledRef.current) setStageProgress(p);
        },
        onStageResult: (r) => {
          // Appended, never merged by id: the engine reports each stage once,
          // in registry order, and rebuilding the row from the report's own
          // object is what keeps the live text and the finished text the same
          // text.
          if (!cancelledRef.current) setLiveResults((prev) => [...prev, r]);
        },
      });
      if (cancelledRef.current) return;
      if (!result) {
        // The engine reports its own failure through the shared error dialog and
        // leaves the document untouched; this line is what stays on screen here.
        setError('The chain did not run. Nothing in the document was changed.');
      } else {
        setReport(result);
      }
    } finally {
      // Reached on EVERY resolution, including the refusal — which is the whole
      // reason this dialog does not wait for the progress bar. That path emits
      // no callback at all, so `progress` is still 0 and `running` still null
      // when it lands, and only the promise says the run is over.
      if (!cancelledRef.current) {
        setBusy(false);
        setRunning(null);
        setStageProgress(null);
      }
    }
  }

  return (
    <DialogShell
      title="Podcast Chain"
      subtitle={doc.name}
      icon={<Podcast size={15} />}
      width={600}
      onClose={onClose}
      dismissable={!busy}
    >
      <div className="flex flex-col gap-3" data-testid="podcast-chain-dialog">
        <div
          data-testid="podcast-chain-scope"
          className="text-xs"
          style={{ color: 'var(--glass-text-muted)' }}
        >
          {scopeText}
        </div>

        <SectionLabel>Stages</SectionLabel>

        {tooManyChannels ? (
          /* D6 — a document the engine will refuse says so HERE, before Apply,
             instead of claiming a target it will never be held to. The engine's
             own sentence verbatim (it names the fix), prefixed with the count
             this document actually has: a paraphrase would be a second place
             for that instruction to go wrong. */
          <p
            data-testid="podcast-chain-channel-refusal"
            className="text-xs"
            style={{ color: 'var(--glass-text-muted)' }}
          >
            This document has {channelCount} channels. {PODCAST_CHANNEL_REFUSAL}
          </p>
        ) : (
          <p className="text-xs" style={{ color: 'var(--glass-text-muted)' }}>
            The stages run top to bottom over the region above, each one on settings worked out
            from the audio that reaches it. This document is {channelWord}, so the pass targets{' '}
            <span className="font-mono">{lufs(targetLufs)}</span>. The whole pass lands as a single
            undo entry.
          </p>
        )}

        <div className="flex flex-col gap-2">
          {PODCAST_CHAIN_STAGES.map((stage) => {
            const result = resultById.get(stage.id);
            const status: StageStatus | null = result ? result.status : null;
            // The live state of this row. A result that has landed decides it;
            // otherwise the stage is switched off, the one the engine is
            // currently reporting on, or still waiting its turn. There is no
            // `manual` branch: every stage in this chain runs.
            const step: StepState = result
              ? STEP_OF_STATUS[result.status]
              : !enabled[stage.id]
                ? 'off'
                : stageProgress?.stageId === stage.id
                  ? 'running'
                  : 'pending';
            const activity = step === 'running' ? stageProgress : null;
            return (
              <div
                key={stage.id}
                data-testid={`podcast-chain-stage-${stage.id}`}
                className="rounded-xl"
                style={{
                  border: `1px solid ${busy && step === 'running' ? 'var(--accent)' : 'var(--glass-border)'}`,
                  background:
                    busy && step === 'running' ? 'var(--accent-ring)' : 'rgba(255, 255, 255, 0.02)',
                  padding: '8px 10px',
                  // Dimmed until it has something to say. Only while the run is
                  // going: before Apply every stage is a choice the user is
                  // making, and after it every stage is a result they are
                  // reading.
                  opacity: busy && step === 'pending' ? 0.55 : 1,
                }}
              >
                <div className="flex items-start gap-2">
                  <input
                    type="checkbox"
                    id={`podcast-chain-toggle-${stage.id}`}
                    data-testid={`podcast-chain-toggle-${stage.id}`}
                    checked={enabled[stage.id]}
                    disabled={locked}
                    onChange={(e) => toggle(stage.id, e.target.checked)}
                    className="mt-0.5 accent-[#26c6da]"
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline justify-between gap-2">
                      <label
                        htmlFor={`podcast-chain-toggle-${stage.id}`}
                        className="text-xs font-semibold"
                        style={{ color: 'var(--glass-text-title)' }}
                      >
                        {stage.label}
                      </label>
                      {busy ? (
                        <span
                          data-testid={`podcast-chain-step-${stage.id}`}
                          data-state={step}
                          className="shrink-0 text-xs"
                          style={{ color: STEP_COLOR[step] }}
                        >
                          {step === 'done' ? '✓ ' : ''}
                          {STEP_TEXT[step]}
                          {activity ? ` · ${Math.round(activity.stageFraction * 100)}%` : ''}
                          {result?.elapsedMs !== undefined
                            ? ` · ${(result.elapsedMs / 1000).toFixed(1)} s`
                            : ''}
                        </span>
                      ) : (
                        status && (
                          <span
                            data-testid={`podcast-chain-status-${stage.id}`}
                            className="shrink-0 text-xs"
                            style={{ color: STATUS_COLOR[status] }}
                          >
                            {STATUS_TEXT[status]}
                            {result?.elapsedMs !== undefined
                              ? ` · ${(result.elapsedMs / 1000).toFixed(1)} s`
                              : ''}
                          </span>
                        )
                      )}
                    </div>
                    <p
                      data-testid={`podcast-chain-note-${stage.id}`}
                      className="mt-1 text-xs"
                      style={{ color: 'var(--glass-text-muted)' }}
                    >
                      {stage.note}
                    </p>
                    {activity && (
                      <div className="mt-1 flex flex-col gap-1">
                        <p
                          data-testid={`podcast-chain-activity-${stage.id}`}
                          className="text-xs"
                          style={{ color: 'var(--glass-text-label)' }}
                        >
                          {PHASE_TEXT[activity.phase]} — {activity.detail}
                        </p>
                        <div
                          className="h-1 w-full overflow-hidden rounded-full"
                          style={{ background: 'rgba(255, 255, 255, 0.09)' }}
                        >
                          <div
                            data-testid={`podcast-chain-stage-progress-${stage.id}`}
                            className="h-full transition-[width]"
                            style={{
                              width: `${Math.round(activity.stageFraction * 100)}%`,
                              background: 'var(--accent)',
                            }}
                          />
                        </div>
                      </div>
                    )}
                    {result && <StageResult result={result} />}
                  </div>
                </div>
              </div>
            );
          })}
        </div>

        {/* The refusal replaces the report entirely: no stage was resolved, so
            there is no stage table and no before/after to show, and rendering an
            empty one would look like a pass that decided nothing. */}
        {refused && (
          <p
            data-testid="podcast-chain-refusal"
            className="text-xs"
            style={{ color: STATUS_COLOR.declined }}
          >
            {report.refusal}
          </p>
        )}

        {report && !refused && (
          <>
            <SectionLabel>Before and after</SectionLabel>

            <table
              data-testid="podcast-chain-summary"
              className="w-full text-xs"
              style={{ borderCollapse: 'collapse' }}
            >
              <thead>
                <tr style={{ color: 'var(--glass-text-muted)' }}>
                  <th className="text-left font-normal" style={{ padding: '2px 0' }}>
                    Measure
                  </th>
                  <th className="text-right font-normal">Before</th>
                  <th className="text-right font-normal">After</th>
                </tr>
              </thead>
              <tbody>
                {METRIC_ROWS.map((row) => (
                  <tr key={row.key} data-testid={`podcast-chain-summary-${row.key}`}>
                    <td style={{ color: 'var(--glass-text-label)', padding: '2px 0' }}>
                      {row.label}
                    </td>
                    <td
                      className="text-right font-mono"
                      style={{ color: 'var(--glass-text-secondary)' }}
                    >
                      {metricText(report.before[row.key], row.unit)}
                    </td>
                    <td className="text-right font-mono" style={{ color: 'var(--glass-text-title)' }}>
                      {metricText(report.after[row.key], row.unit)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            <p
              data-testid="podcast-chain-target"
              className="text-xs"
              style={{ color: 'var(--glass-text-label)' }}
            >
              Delivery target for this {channelWord} document:{' '}
              <span className="font-mono">{lufs(targetLufs)}</span>
              {limiterApplied
                ? ', with the limiter holding the sample peak at or under its ceiling.'
                : '. The Limiter did not run, so nothing held the sample peak — read it off the row above.'}
            </p>

            <p
              data-testid="podcast-chain-outcome"
              className="text-xs"
              style={{ color: 'var(--glass-text-label)' }}
            >
              {report.applied
                ? `Applied in ${(report.elapsedMs / 1000).toFixed(1)} s as one undo entry (“${PODCAST_CHAIN_UNDO_LABEL}”).${
                    report.outputSamples !== report.regionSamples
                      ? ` Region length ${secs(report.regionSamples, report.sampleRate)} → ${secs(
                          report.outputSamples,
                          report.sampleRate
                        )}.`
                      : ''
                  }`
                : 'No stage ran, so the document was not changed.'}
            </p>
          </>
        )}

        {error && (
          <p data-testid="podcast-chain-error" className="text-xs text-[#ef5350]">
            {error}
          </p>
        )}

        {busy && (
          <div>
            {/* Named as the WHOLE PASS, because the highlighted row above shows
                its own bar at its own number and the two legitimately disagree:
                mid-way through the stage that carries half the weight the row
                reads 50 % while this one reads 27 %. Unlabelled, that difference
                reads as a bug in one of them. */}
            <p
              data-testid="podcast-chain-running"
              className="mb-1 text-xs"
              style={{ color: 'var(--glass-text-muted)' }}
            >
              {running ? `Whole pass — running ${running}…` : 'Whole pass — starting…'}
            </p>
            <div
              className="h-1.5 w-full overflow-hidden rounded-full"
              style={{
                background: 'rgba(255, 255, 255, 0.09)',
                boxShadow: 'inset 0 1px 2px rgba(0, 0, 0, 0.6)',
              }}
            >
              <div
                data-testid="podcast-chain-progress"
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
          {finished ? (
            <GlassButton variant="primary" data-testid="podcast-chain-close" onClick={onClose}>
              Close
            </GlassButton>
          ) : (
            <>
              <GlassButton data-testid="podcast-chain-cancel" onClick={onClose} disabled={busy}>
                Cancel
              </GlassButton>
              <GlassButton
                variant="primary"
                data-testid="podcast-chain-apply"
                onClick={() => void handleApply()}
                disabled={busy || !anyEnabled || tooManyChannels}
              >
                Apply
              </GlassButton>
            </>
          )}
        </div>
      </div>
    </DialogShell>
  );
}
