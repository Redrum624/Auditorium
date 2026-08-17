import { useEffect, useRef, useState } from 'react';
import { ListChecks } from 'lucide-react';
import { docLength } from '../../audio/AudioDocument';
import type { StageDelta } from '../../dsp/chainAnalysis';
import { useAppStore } from '../../stores/appStore';
import {
  VOCAL_CHAIN_STAGES,
  VOCAL_CHAIN_UNDO_LABEL,
  defaultStageSelection,
  runVocalChain,
  type ChainStagePhase,
  type StageStatus,
  type VocalChainMetrics,
  type VocalChainReport,
  type VocalChainStageId,
  type VocalChainStageProgress,
  type VocalChainStageResult,
} from '../../services/vocalChain';
import { noiseGateEffect } from '../../effects/dynamics/NoiseGateEffect';
import { GlassButton, SectionLabel } from '../UI/glass';
import DialogShell from './DialogShell';

const dbfs = (v: number): string => (Number.isFinite(v) ? `${v.toFixed(1)} dBFS` : '—');
const db = (v: number): string => (Number.isFinite(v) ? `${v.toFixed(1)} dB` : '—');
const pct = (v: number): string => `${(v * 100).toFixed(1)}%`;
const secs = (samples: number, rate: number): string => `${(samples / rate).toFixed(2)} s`;

/** What each status SAYS, in the words a user can act on. `applied` claims only
 * that the stage ran — how well it ran is what the measured delta below it is
 * for, and is not something this dialog is in a position to grade. */
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

/**
 * The live stepper (P1).
 *
 * Every stage is listed top to bottom before, during and after the run — that
 * part never changed. What the row could not say WHILE the run was going is
 * which stage is running, how far through it the pass is, and what it is doing;
 * the dialog had one overall fraction and one stage label for a pass whose
 * slowest stage alone takes a minute.
 *
 * `done` and `declined` are separate states rather than one "finished": a stage
 * that declined is the outcome easiest to mistake for a successful one, and
 * that is the same reason the finished report keeps them apart in amber.
 *
 * The live badge REPLACES the status word while the run is going, in the same
 * slot, so a row never carries two verdicts at once. Everything the row says
 * BELOW the badge is the report's own block, rendered from the very result
 * object the engine will put in `report.stages` — there is no second set of
 * strings here, which is why a finished row looks the same before and after the
 * run lands.
 */
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

/** What the finished statuses become as a live step. A result that has landed
 * is a step that is over, whatever it decided. */
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

/** The gate's OWN threshold parameter — its range, step and default come from
 * the effect that will receive them, so the box cannot offer a level the gate
 * would silently clamp. Taken from the definition rather than through
 * `getEffect`, which needs a registry this module cannot assume has been
 * filled by the time it is imported. */
const GATE_THRESHOLD_PARAM = noiseGateEffect.params.find((p) => p.id === 'thresholdDb')!;

const METRIC_ROWS: { key: keyof VocalChainMetrics; label: string; unit: 'dbfs' | 'db' }[] = [
  { key: 'rmsDb', label: 'RMS', unit: 'dbfs' },
  { key: 'peakDb', label: 'Peak', unit: 'dbfs' },
  { key: 'crestDb', label: 'Crest', unit: 'db' },
  { key: 'noiseFloorDb', label: 'Noise floor', unit: 'dbfs' },
];

/** `null` is a real answer here — there was no passage above digital silence to
 * measure a floor in — and it is rendered as one rather than as a zero. */
function metricText(value: number | null, unit: 'dbfs' | 'db'): string {
  if (value === null) return 'n/a';
  return unit === 'dbfs' ? dbfs(value) : db(value);
}

/** The four numbers every applied stage reports, in one line. `identicalFraction`
 * and `differenceRmsDb` are absent for the length-changing stages, where there is
 * no sample-to-sample correspondence to compare — so they are omitted rather
 * than printed as 0. */
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
 * amber, because both are "read this" — the cover chain's shape exactly. */
function StageResult({ result }: { result: VocalChainStageResult }) {
  if (result.status === 'declined') {
    return (
      <p
        data-testid={`vocal-chain-reason-${result.id}`}
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
          data-testid={`vocal-chain-warning-${result.id}`}
          className="text-xs"
          style={{ color: STATUS_COLOR.declined }}
        >
          Warning — {result.warning}
        </p>
      )}
      {result.derived.map((d) => (
        <p
          key={d.label}
          data-testid={`vocal-chain-derived-${result.id}`}
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
          data-testid={`vocal-chain-detail-${result.id}`}
          className="text-xs"
          style={{ color: 'var(--glass-text-label)' }}
        >
          {result.detail}
        </p>
      )}
      {result.delta && (
        <p
          data-testid={`vocal-chain-delta-${result.id}`}
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
 * F7 — the Vocal Chain.
 *
 * The engine (`services/vocalChain.ts`) owns the order, the derivations and the
 * single undo entry. This dialog owns one job, and it is not "press go": it is
 * to make the pass ACCOUNTABLE, before and after.
 *
 * Before: every stage is listed in the order it will run, with the note that
 * says why it sits there and why it is on or off — and every stage is switchable
 * on its own. A stage the user cannot see or refuse is a stage that ran without
 * being seen.
 *
 * During: the same list, live. Every row carries a state — waiting, running,
 * ran, did not run, switched off — so the whole pass is legible top to bottom
 * while it happens; the running row is highlighted and says what it is doing
 * (measuring its settings, or rendering with the settings it just measured) and
 * how far through ITSELF it is. The bar at the foot is the whole pass, weighted
 * by the measured stage times, and that is the number it was always right for:
 * it cannot say which of thirteen stages the minute is being spent in.
 *
 * After: every stage says what it did. The settings it derived and what it
 * derived them FROM, the measured before/after RMS and peak, and how much of the
 * audio it left bit-identical. A stage that declined says so in amber with the
 * measurement that made it decline — never anything that could be mistaken for
 * having run. A stage that RAN but produced something the user has to know
 * about — the reverb's tail with the Limiter switched off, which lands over full
 * scale and is hard-clipped by both writers — carries its warning in the same
 * amber, above its measurements rather than instead of them.
 *
 * The two stages with `effectId === null` (Align Lyrics and Align Vocal Timing)
 * are listed without a checkbox: each needs the user to say WHICH thing to
 * change — which word, which syllables — so each is a separate dialog run
 * BEFORE this one, and offering a tick here would promise something the chain
 * cannot do.
 *
 * Nothing here grades the result. The numbers are stated; whether they are the
 * ones the user wanted is the user's call.
 */
export default function VocalChainDialog({ onClose }: { onClose: () => void }) {
  const doc = useAppStore((s) => s.documents.find((d) => d.id === s.activeDocumentId) ?? null);
  const selection = useAppStore((s) => s.selection);

  const [enabled, setEnabled] = useState<Record<VocalChainStageId, boolean>>(defaultStageSelection);
  // V2/R2 — the one setting here that comes from a person rather than from the
  // recording. Two pieces of state, not one: the tick is the user SAYING they
  // want to name a level, and only then does a level exist to send. A single
  // nullable number would make "off" and "off, but I typed -42 earlier"
  // indistinguishable, and the engine would receive a threshold nobody asked
  // it to use. Untying them also means the box is gone entirely until asked
  // for — an empty field beside a stage that decides for itself reads as a
  // setting the user forgot to fill in.
  //
  // The level is `number | null` rather than `number` because a person clears a
  // box to unsay a number, and `Number('')` is 0 — which is not "nothing", it is
  // FULL SCALE, the one threshold that gates an entire take. `null` is that
  // cleared state: the tick still says the user means to name a level, and no
  // level exists yet, so nothing may be applied until one does.
  const [gateManual, setGateManual] = useState(false);
  const [gateThresholdDb, setGateThresholdDb] = useState<number | null>(GATE_THRESHOLD_PARAM.default as number);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [running, setRunning] = useState<string | null>(null);
  const [report, setReport] = useState<VocalChainReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The live half of the stepper. `liveResults` holds the engine's OWN result
  // objects as they land — the same ones `report.stages` will carry — and
  // `stageProgress` holds the last thing the running stage said about itself.
  const [liveResults, setLiveResults] = useState<VocalChainStageResult[]>([]);
  const [stageProgress, setStageProgress] = useState<VocalChainStageProgress | null>(null);

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

  // The finished report wins the moment it exists, and a run that FAILED shows
  // nothing: `runVocalChain` resolves null after rolling the document back, and
  // the stages that had already reported would otherwise be left on screen
  // looking like an outcome of a pass that changed nothing.
  const resultById = new Map<VocalChainStageId, VocalChainStageResult>(
    (report ? report.stages : busy ? liveResults : []).map((r) => [r.id, r] as const)
  );
  const anyEnabled = VOCAL_CHAIN_STAGES.some((s) => s.effectId !== null && enabled[s.id]);
  const done = report !== null && report.applied;
  const locked = busy || done;
  // The tick is a promise to name a level, and an empty box has not named one.
  // Applying anyway would either gate at full scale or silently fall back to the
  // derivation the user just said they did not want — so Apply waits, and says
  // what it is waiting for. Tied to `enabled.gate` for the same reason the
  // controls are: a level for a stage that will not run blocks nothing.
  const gateLevelMissing = gateManual && enabled.gate && gateThresholdDb === null;

  function toggle(id: VocalChainStageId, next: boolean): void {
    setEnabled((prev) => ({ ...prev, [id]: next }));
  }

  async function handleApply(): Promise<void> {
    if (busy || done || !anyEnabled || gateLevelMissing) return;
    setBusy(true);
    setProgress(0);
    setRunning(null);
    setError(null);
    setReport(null);
    setLiveResults([]);
    setStageProgress(null);
    try {
      const result = await runVocalChain({
        enabled,
        // Sent only when the user asked for it AND named it — see the state
        // above. `handleApply` cannot be reached with the tick on and the box
        // empty, so this narrowing never silently swallows a level.
        ...(gateManual && gateThresholdDb !== null ? { gateThresholdDb } : {}),
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
      if (!cancelledRef.current) {
        setBusy(false);
        setRunning(null);
        setStageProgress(null);
      }
    }
  }

  return (
    <DialogShell
      title="Vocal Chain"
      subtitle={doc.name}
      icon={<ListChecks size={15} />}
      width={600}
      onClose={onClose}
      dismissable={!busy}
    >
      <div className="flex flex-col gap-3" data-testid="vocal-chain-dialog">
        <div data-testid="vocal-chain-scope" className="text-xs" style={{ color: 'var(--glass-text-muted)' }}>
          {scopeText}
        </div>

        <SectionLabel>Stages</SectionLabel>

        <p className="text-xs" style={{ color: 'var(--glass-text-muted)' }}>
          The stages run top to bottom over the region above, each one on settings worked out from the audio that
          reaches it. The whole pass lands as a single undo entry.
        </p>

        <div className="flex flex-col gap-2">
          {VOCAL_CHAIN_STAGES.map((stage) => {
            const result = resultById.get(stage.id);
            const manual = stage.effectId === null;
            const status: StageStatus | null = result ? result.status : manual ? 'manual' : null;
            // The live state of this row. A result that has landed decides it;
            // otherwise the stage is manual, switched off, the one the engine is
            // currently reporting on, or still waiting its turn.
            const step: StepState = result
              ? STEP_OF_STATUS[result.status]
              : manual
                ? 'manual'
                : !enabled[stage.id]
                  ? 'off'
                  : stageProgress?.stageId === stage.id
                    ? 'running'
                    : 'pending';
            const activity = step === 'running' ? stageProgress : null;
            return (
              <div
                key={stage.id}
                data-testid={`vocal-chain-stage-${stage.id}`}
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
                  {!manual && (
                    <input
                      type="checkbox"
                      id={`vocal-chain-toggle-${stage.id}`}
                      data-testid={`vocal-chain-toggle-${stage.id}`}
                      checked={enabled[stage.id]}
                      disabled={locked}
                      onChange={(e) => toggle(stage.id, e.target.checked)}
                      className="mt-0.5 accent-[#26c6da]"
                    />
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline justify-between gap-2">
                      {manual ? (
                        <span className="text-xs font-semibold" style={{ color: 'var(--glass-text-title)' }}>
                          {stage.label}
                        </span>
                      ) : (
                        <label
                          htmlFor={`vocal-chain-toggle-${stage.id}`}
                          className="text-xs font-semibold"
                          style={{ color: 'var(--glass-text-title)' }}
                        >
                          {stage.label}
                        </label>
                      )}
                      {busy ? (
                        <span
                          data-testid={`vocal-chain-step-${stage.id}`}
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
                            data-testid={`vocal-chain-status-${stage.id}`}
                            className="shrink-0 text-xs"
                            style={{ color: STATUS_COLOR[status] }}
                          >
                            {STATUS_TEXT[status]}
                            {result?.elapsedMs !== undefined ? ` · ${(result.elapsedMs / 1000).toFixed(1)} s` : ''}
                          </span>
                        )
                      )}
                    </div>
                    <p
                      data-testid={`vocal-chain-note-${stage.id}`}
                      className="mt-1 text-xs"
                      style={{ color: 'var(--glass-text-muted)' }}
                    >
                      {stage.note}
                    </p>
                    {stage.id === 'gate' && (
                      <div className="mt-1.5 flex flex-wrap items-center gap-2">
                        <input
                          type="checkbox"
                          id="vocal-chain-gate-manual"
                          data-testid="vocal-chain-gate-manual"
                          checked={gateManual}
                          // ...and inert when the stage itself is off, which is
                          // the only dependency between two controls here: a
                          // level for a stage that will not run is a promise
                          // the Apply cannot keep.
                          disabled={locked || !enabled.gate}
                          onChange={(e) => setGateManual(e.target.checked)}
                          className="accent-[#26c6da]"
                        />
                        <label
                          htmlFor="vocal-chain-gate-manual"
                          className="text-xs"
                          style={{ color: 'var(--glass-text-label)' }}
                        >
                          Gate at a level I set instead
                        </label>
                        {gateManual && (
                          <>
                            <input
                              type="number"
                              aria-label="Gate threshold in dBFS"
                              data-testid="vocal-chain-gate-threshold"
                              value={gateThresholdDb ?? ''}
                              min={GATE_THRESHOLD_PARAM.min}
                              max={GATE_THRESHOLD_PARAM.max}
                              step={GATE_THRESHOLD_PARAM.step}
                              disabled={locked || !enabled.gate}
                              onChange={(e) => {
                                // An empty box is the ONE input this reads as a
                                // value rather than a typo: it is how the level
                                // is unsaid. Everything else unparseable (a lone
                                // "-", "e") leaves the last named level standing,
                                // because a half-typed number is not a decision.
                                if (e.target.value === '') {
                                  setGateThresholdDb(null);
                                  return;
                                }
                                const v = Number(e.target.value);
                                if (Number.isFinite(v)) setGateThresholdDb(v);
                              }}
                              className="w-20 rounded px-1.5 py-0.5 text-right font-mono text-xs"
                              style={{
                                background: 'rgba(255, 255, 255, 0.06)',
                                border: '1px solid var(--glass-border)',
                                color: 'var(--glass-text-title)',
                              }}
                            />
                            <span className="text-xs" style={{ color: 'var(--glass-text-muted)' }}>
                              dBFS — everything under this goes to silence, with the same hold and fades. The
                              stage will say the threshold was yours.
                            </span>
                            {gateLevelMissing && (
                              <span
                                data-testid="vocal-chain-gate-threshold-missing"
                                className="text-xs text-[#ffb74d]"
                              >
                                Type a level, or untick this to let the stage decide for itself.
                              </span>
                            )}
                          </>
                        )}
                      </div>
                    )}
                    {activity && (
                      <div className="mt-1 flex flex-col gap-1">
                        <p
                          data-testid={`vocal-chain-activity-${stage.id}`}
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
                            data-testid={`vocal-chain-stage-progress-${stage.id}`}
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

        {report && (
          <>
            <SectionLabel>Before and after</SectionLabel>

            <table data-testid="vocal-chain-summary" className="w-full text-xs" style={{ borderCollapse: 'collapse' }}>
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
                  <tr key={row.key} data-testid={`vocal-chain-summary-${row.key}`}>
                    <td style={{ color: 'var(--glass-text-label)', padding: '2px 0' }}>{row.label}</td>
                    <td className="text-right font-mono" style={{ color: 'var(--glass-text-secondary)' }}>
                      {metricText(report.before[row.key], row.unit)}
                    </td>
                    <td className="text-right font-mono" style={{ color: 'var(--glass-text-title)' }}>
                      {metricText(report.after[row.key], row.unit)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            <p data-testid="vocal-chain-outcome" className="text-xs" style={{ color: 'var(--glass-text-label)' }}>
              {report.applied
                ? `Applied in ${(report.elapsedMs / 1000).toFixed(1)} s as one undo entry (“${VOCAL_CHAIN_UNDO_LABEL}”).${
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
          <p data-testid="vocal-chain-error" className="text-xs text-[#ef5350]">
            {error}
          </p>
        )}

        {busy && (
          <div>
            {/* Named as the WHOLE PASS, because the highlighted row above shows
                its own bar at its own number and the two legitimately disagree:
                mid-way through a stage that carries most of the weight the row
                reads 50 % while this one reads 41 %. Unlabelled, that difference
                reads as a bug in one of them. */}
            <p data-testid="vocal-chain-running" className="mb-1 text-xs" style={{ color: 'var(--glass-text-muted)' }}>
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
                data-testid="vocal-chain-progress"
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
            <GlassButton variant="primary" data-testid="vocal-chain-close" onClick={onClose}>
              Close
            </GlassButton>
          ) : (
            <>
              <GlassButton data-testid="vocal-chain-cancel" onClick={onClose} disabled={busy}>
                Cancel
              </GlassButton>
              <GlassButton
                variant="primary"
                data-testid="vocal-chain-apply"
                onClick={() => void handleApply()}
                disabled={busy || !anyEnabled || gateLevelMissing}
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
