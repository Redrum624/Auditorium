import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, Shuffle } from 'lucide-react';
import { docLength } from '../../audio/AudioDocument';
import { useAppStore } from '../../stores/appStore';
import { parseTime } from '../../utils/timeFormat';
import { DEFAULT_REMIX_WEIGHTS } from '../../dsp/remixCost';
import { deriveRemixFeatures, type RemixAnalysis } from '../../dsp/remixFeatures';
import { effectiveCrossfadeMs } from '../../dsp/remixRender';
import {
  DEFAULT_MAX_REPEAT_FACTOR,
  planRemix,
  type PlanRemixOptions,
  type PlanRemixResult,
} from '../../dsp/remixPlan';
import { regridTempo, runRemixAnalysis, setRemixAnalysis } from '../../services/tempoAnalysis';
import { createRemixDocument } from '../../services/remixService';
import { focusRemixPanel } from '../../services/dialogBus';
// Structure-strip derivation + meter labels are shared with the persistent
// TEMPO card (G4) — one colour cycle, one run derivation, one meter label.
import { clusterColor, meterLabel, METERS, structureRuns } from '../../utils/structureStrip';
import { FieldLabel, GlassButton, GlassField, GlassSelect, GlassSlider, SectionLabel } from '../UI/glass';
import DialogShell from './DialogShell';

/** Small chip-sized GlassButton geometry (the mockup's `.chip`). */
const CHIP = { padding: '2px 8px', fontSize: 11 } as const;

const ANALYSIS_FAILED = 'Beat analysis did not produce a usable grid for this document.';

/** `m:ss` — the coarse grain every length in this dialog is expressed in
 * (durations are bar-quantised anyway, so milliseconds would be noise). */
function formatMmss(samples: number, sampleRate: number): string {
  const total = Number.isFinite(samples) ? Math.max(0, Math.round(samples / sampleRate)) : 0;
  const minutes = Math.floor(total / 60);
  return `${minutes}:${String(total - minutes * 60).padStart(2, '0')}`;
}

/** `deriveRemixFeatures`'s `ChromaResult` argument, rebuilt from the analysis
 * that already carries it — this is what makes a meter/downbeat/tempo override
 * cost milliseconds instead of another chroma + onset pass. */
function chromaOf(analysis: RemixAnalysis) {
  return {
    chroma: analysis.chroma,
    numFrames: analysis.numChromaFrames,
    chromaRate: analysis.chromaRate,
  };
}

/**
 * Feature 3 UI (Task T14): the Auto-Remix dialog. Minimal per the plan's
 * bare-function ruling — required fields, a confirm button, one inline error
 * line — with three deliberate exceptions the plan marks as CORRECTNESS, not
 * polish:
 *
 * 1. **x2 / /2 octave correction.** Confidence cannot gate octave errors (a
 *    half-tempo detection scored the HIGHEST confidence in the whole fixture
 *    bank), and a 2x error puts every cut mid-phrase — unrecoverable output.
 *    The control calls `regridTempo`, which RE-TRACKS the beat grid at the
 *    corrected period; relabelling the displayed BPM is forbidden, because
 *    `beatSamples` at the wrong octave physically contains only every other
 *    beat and the planner splices on those positions (T2 carry-forward).
 * 2. **Mandatory tempo confirmation.** Create stays disabled until the user
 *    either ticks "Tempo is correct" or performs an explicit tempo action
 *    (x2, /2, or applying a typed BPM) — the one moment a bad detection is
 *    still cheap to fix.
 * 3. **The structure strip**, which is what makes a bad tempo or downbeat
 *    detection VISIBLE before the user commits to a target.
 *
 * Meter and downbeat overrides re-run `deriveRemixFeatures` ONLY (the spectra
 * are cached on the analysis itself) — a downbeat shift changes the PHASE of
 * the bar grid, not the beat period, so `regridTempo` is deliberately NOT on
 * that path (Plan Ruling 4: re-tracking at an unchanged period returns an
 * identical grid).
 *
 * Every corrected analysis is published back through
 * `setRemixAnalysis(doc, ...)`, because `createRemixDocument` resolves the
 * analysis from the shared cache: without the write-back a correction would
 * be visible in this dialog and absent from the rendered remix — and after a
 * `regridTempo` the cache row is a `deriveGrid` result carrying no bar
 * boundaries at all, which the re-derived analysis repairs.
 *
 * Failure states render INLINE in amber so the dialog stays open and the user
 * can adjust; nothing here opens a message box.
 */
export default function RemixDialog({ onClose }: { onClose: () => void }) {
  const doc = useAppStore((s) => s.documents.find((d) => d.id === s.activeDocumentId) ?? null);
  // The document this dialog analysed. The TARGET is still resolved from live
  // state at confirm time — this id only decides whether the analysis on
  // screen still describes it.
  const [docId] = useState<string | null>(() => doc?.id ?? null);
  const sampleRate = doc?.sampleRate ?? 44100;

  const [analysis, setAnalysis] = useState<RemixAnalysis | null>(null);
  const [analysing, setAnalysing] = useState(false);
  const [correcting, setCorrecting] = useState(false);
  const [creating, setCreating] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const [beatsPerBar, setBeatsPerBar] = useState(4);
  const [downbeatShift, setDownbeatShift] = useState(0);
  const [bpmDraft, setBpmDraft] = useState('');
  const [tempoConfirmed, setTempoConfirmed] = useState(false);

  const [targetSample, setTargetSample] = useState<number | null>(null);
  const [targetDraft, setTargetDraft] = useState('');
  const [phraseBars, setPhraseBars] = useState(8);
  const [strict, setStrict] = useState(true);
  const [crossfadeMs, setCrossfadeMs] = useState(25);
  const [allowRepeats, setAllowRepeats] = useState(true);
  const [markEditPoints, setMarkEditPoints] = useState(true);
  const [exactLength, setExactLength] = useState(false);

  const busy = analysing || correcting || creating;
  // The unmount-cleanup mirror (EffectDialog.tsx:54,65-72's busyRef, in the
  // shape this dialog actually needs): a ref, because the cleanup must read
  // the CURRENT value rather than the one captured when the effect was
  // installed. Every async continuation below checks it before touching
  // state, so Escape or a backdrop click during a multi-second analysis
  // unmounts cleanly. It is deliberately NOT a worker kill switch: the tempo
  // worker terminates itself on every terminal branch (tempoAnalysis.ts's
  // choreography) and the plan worker belongs to the remix SESSION, which
  // outlives this dialog — neither is orphaned, and neither is this dialog's
  // to terminate.
  const cancelledRef = useRef(false);

  useEffect(() => {
    cancelledRef.current = false;
    return () => {
      cancelledRef.current = true;
    };
  }, []);

  // Phase 1: analysis starts on open and is instant on re-open (the shared
  // cache hit-tests on channel identity).
  useEffect(() => {
    if (!docId) return;
    const source = useAppStore.getState().documents.find((d) => d.id === docId);
    if (!source) return;

    setAnalysing(true);
    setProgress(0);
    void (async () => {
      const result = await runRemixAnalysis(source, undefined, (fraction) => {
        if (!cancelledRef.current) setProgress(fraction);
      });
      if (cancelledRef.current) return;
      if (!result) {
        setError(ANALYSIS_FAILED);
      } else {
        setAnalysis(result);
        setBeatsPerBar(result.beatsPerBar);
        setTargetSample(result.analyzedEndSample);
        setTargetDraft(formatMmss(result.analyzedEndSample, source.sampleRate));
        if (result.bpm !== null) setBpmDraft(result.bpm.toFixed(1));
      }
      setAnalysing(false);
    })();
  }, [docId]);

  const weights = useMemo(
    () => ({ ...DEFAULT_REMIX_WEIGHTS, phrase: strict ? 3.0 : 1.0 }),
    [strict]
  );

  // A tempo the USER asserted opens the planner's tempo gate through its own
  // flag (`remixPlan.ts`: `confidence < CONFIDENCE_LOW && !tempoConfirmed ->
  // 'no-tempo'`) — which is what the plan's own "Enter a BPM manually to
  // continue" instruction promises. `confidence` is a MEASUREMENT and is
  // never touched here: overwriting it would silence the status bar's
  // uncertainty marker (T5) app-wide on a document whose detection really is
  // weak, and would disguise a human assertion as a DSP result.
  const effectiveAnalysis = useMemo(() => {
    if (!analysis) return null;
    if (!tempoConfirmed || analysis.tempoConfirmed) return analysis;
    return { ...analysis, tempoConfirmed: true };
  }, [analysis, tempoConfirmed]);

  const plan: PlanRemixResult | null = useMemo(() => {
    if (!effectiveAnalysis || targetSample === null) return null;
    const options: PlanRemixOptions = {
      targetSample,
      weights,
      phraseBars,
      strict,
      allowRepeats,
      maxRepeatFactor: DEFAULT_MAX_REPEAT_FACTOR,
      exactLength,
      rollIndex: 0,
    };
    return planRemix(effectiveAnalysis, options);
  }, [effectiveAnalysis, targetSample, weights, phraseBars, strict, allowRepeats, exactLength]);

  const runs = useMemo(() => structureRuns(analysis), [analysis]);

  // Structurally unusable: no tempo at all, or a grid with no bars to splice
  // on. Distinct from the planner's own 'no-tempo' refusal, which is the
  // confidence gate; both surface the same hint.
  const noTempo =
    analysis !== null &&
    (analysis.bpm === null || analysis.numBars < 1 || (plan !== null && !plan.ok && plan.reason === 'no-tempo'));

  let hint: string | null = null;
  if (noTempo && analysis) {
    hint = `No steady tempo detected (confidence ${analysis.confidence.toFixed(2)}). Enter a BPM manually to continue.`;
  } else if (plan && !plan.ok) {
    if (plan.reason === 'too-short') {
      hint = `Shortest sensible remix is ${formatMmss(plan.minOutputSample, sampleRate)}.`;
    } else if (plan.reason === 'too-long') {
      hint = `Longest is ${formatMmss(plan.maxOutputSample, sampleRate)} (${DEFAULT_MAX_REPEAT_FACTOR}x the original).`;
    } else {
      hint = plan.message;
    }
  }

  // Defect 4a: `renderRemix` clamps the requested crossfade to a quarter of the
  // median beat period, so this field's 5-120 ms range over-promises from
  // ~125 BPM up. The clamp is deliberate and stays; what changes is that the
  // width actually applied is stated, derived from THIS analysis's own tracked
  // beats through the renderer's own function — never a per-BPM guess here.
  const appliedCrossfadeMs = analysis
    ? Math.round(effectiveCrossfadeMs(crossfadeMs, analysis.beatSamples, sampleRate))
    : crossfadeMs;
  const crossfadeCapped = appliedCrossfadeMs < crossfadeMs;

  const canCreate =
    !busy && !noTempo && tempoConfirmed && targetSample !== null && plan !== null && plan.ok;

  function liveDoc() {
    const state = useAppStore.getState();
    return state.documents.find((d) => d.id === state.activeDocumentId) ?? null;
  }

  function clampTarget(samples: number): number {
    if (!plan) return samples;
    return Math.min(plan.maxOutputSample, Math.max(plan.minOutputSample, samples));
  }

  /** Both target controls clamp LIVE to the plan's reachable window, so an
   * unreachable request is mostly prevented rather than reported. */
  function commitTargetSamples(samples: number): void {
    const clamped = clampTarget(Math.round(samples));
    setTargetSample(clamped);
    setTargetDraft(formatMmss(clamped, sampleRate));
  }

  function handleTargetText(text: string): void {
    setTargetDraft(text);
    const parsed = parseTime(text, sampleRate);
    if (parsed === null) return;
    const clamped = clampTarget(parsed);
    setTargetSample(clamped);
    if (clamped !== parsed) setTargetDraft(formatMmss(clamped, sampleRate));
  }

  /** Adopts a re-derived analysis and publishes it to the shared cache, so
   * `createRemixDocument` plans against exactly what is on screen. The user's
   * tempo assertion is carried ON the analysis, so it survives both the
   * write-back and a later `regridTempo` re-derive (an octave correction IS an
   * assertion, so it sets the flag rather than clearing it). */
  function publish(next: RemixAnalysis, tempoAsserted: boolean): void {
    const confirmed = tempoAsserted || tempoConfirmed;
    const stamped = confirmed ? { ...next, tempoConfirmed: true } : next;
    setAnalysis(stamped);
    setError(null);
    const live = liveDoc();
    if (live && live.id === docId) setRemixAnalysis(live, stamped);
    if (stamped.bpm !== null) setBpmDraft(stamped.bpm.toFixed(1));
    if (tempoAsserted) setTempoConfirmed(true);
  }

  /** Meter / downbeat: `deriveRemixFeatures` ONLY (milliseconds). */
  function rederive(nextBeatsPerBar: number, nextShift: number): void {
    if (!analysis) return;
    publish(
      deriveRemixFeatures(analysis, chromaOf(analysis), {
        beatsPerBar: nextBeatsPerBar,
        downbeatShiftBeats: nextShift,
      }),
      false
    );
  }

  /**
   * Tempo: re-TRACK at `newPeriodFrames` through `regridTempo`, then re-derive
   * the remix features from the corrected grid — merging back the `bands`/
   * `odfLow` the regrid path cannot produce (`deriveGrid` never re-runs the
   * onset pass), which is what keeps the descriptors and clusters real.
   */
  async function regridAndDerive(newPeriodFrames: number): Promise<void> {
    const live = liveDoc();
    if (!analysis || !live || live.id !== docId) return;
    setCorrecting(true);
    setError(null);
    try {
      const entry = await regridTempo(live.id, newPeriodFrames);
      if (cancelledRef.current) return;
      if (!entry || entry.bpm === null) {
        setError('Tempo correction failed — the beat grid is unchanged.');
        return;
      }
      const corrected = deriveRemixFeatures(
        { ...entry, bands: analysis.bands, numBands: analysis.numBands, odfLow: analysis.odfLow },
        chromaOf(analysis),
        { beatsPerBar, downbeatShiftBeats: downbeatShift }
      );
      publish(corrected, true);
    } finally {
      if (!cancelledRef.current) setCorrecting(false);
    }
  }

  async function applyTypedBpm(): Promise<void> {
    if (!analysis || analysis.bpm === null) return;
    const typed = Number(bpmDraft);
    if (!Number.isFinite(typed) || typed <= 0) return;
    // Period scales inversely with tempo, so this needs no rate constants.
    await regridAndDerive(analysis.periodFrames * (analysis.bpm / typed));
  }

  async function handleCreate(): Promise<void> {
    if (!canCreate || !effectiveAnalysis || targetSample === null) return;
    // Resolved from LIVE state, never captured at open.
    const live = liveDoc();
    if (!live) {
      setError('No document is open.');
      return;
    }
    if (live.id !== docId) {
      setError('The active document changed — reopen Auto-Remix for it.');
      return;
    }

    setCreating(true);
    setProgress(0);
    setError(null);
    try {
      setRemixAnalysis(live, effectiveAnalysis);
      const result = await createRemixDocument({
        sourceDocId: live.id,
        targetSample,
        phraseBars,
        strict,
        allowRepeats,
        crossfadeMs,
        exactLength,
        markEditPoints,
        weights,
        analysisParams: { beatsPerBar, downbeatShiftBeats: downbeatShift },
        onProgress: setProgress,
      });
      if (cancelledRef.current) return;
      if (!result.ok) {
        setError(result.message);
        return;
      }
      onClose();
      focusRemixPanel();
    } finally {
      if (!cancelledRef.current) setCreating(false);
    }
  }

  if (!doc) return null;

  return (
    <DialogShell
      title="Auto-Remix"
      subtitle={`${doc.name} · ${formatMmss(docLength(doc), sampleRate)}`}
      icon={<Shuffle size={15} />}
      width={600}
      onClose={onClose}
      dismissable={!busy}
      // U2-3: hosted in the module column, hold the app only for the passes the
      // USER started. `busy` includes `analysing`, which this dialog begins in a
      // MOUNT effect — so defaulting the lock to `!dismissable` greyed every
      // module entry and suspended the global shortcuts the instant Auto-Remix
      // opened, for a tempo analysis nobody asked for and nobody could stop.
      // The ✕, Escape and the backdrop still follow `dismissable`, so the
      // analysis keeps its own veto; it just no longer freezes the app.
      moduleLock={correcting || creating}
    >
      <div className="flex flex-col gap-3" data-testid="remix-dialog">
        {analysing && (
          <div>
            <p className="mb-1 text-xs" style={{ color: 'var(--glass-text-muted)' }}>
              Analyzing beat grid…
            </p>
            <div
              className="h-1.5 w-full overflow-hidden rounded-full"
              style={{
                background: 'rgba(255, 255, 255, 0.09)',
                boxShadow: 'inset 0 1px 2px rgba(0, 0, 0, 0.6)',
              }}
            >
              <div
                data-testid="remix-progress"
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

        {analysis && (
          <>
            <SectionLabel>Analysis</SectionLabel>

            <div className="flex items-baseline justify-between gap-2">
              <span
                data-testid="remix-summary"
                className="font-mono"
                style={{ fontSize: 15, color: 'var(--glass-text-title)' }}
              >
                {`${analysis.bpm !== null ? analysis.bpm.toFixed(1) : '—'} BPM · ${meterLabel(
                  analysis.beatsPerBar
                )} · ${analysis.numBars} bars`}
              </span>
              <span
                data-testid="remix-confidence"
                className="text-xs"
                style={{ color: 'var(--glass-text-secondary)' }}
              >
                {`${'●'.repeat(Math.max(0, Math.min(5, Math.round(analysis.confidence * 5))))}${'○'.repeat(
                  5 - Math.max(0, Math.min(5, Math.round(analysis.confidence * 5)))
                )} ${analysis.confidence.toFixed(2)}`}
              </span>
            </div>

            <div
              className="flex w-full overflow-hidden rounded-lg"
              style={{ height: 34 }}
              data-testid="remix-structure"
            >
              {runs.map((run, i) => (
                <div
                  key={i}
                  data-testid="remix-structure-block"
                  title={`${formatMmss(run.startSample, sampleRate)} – ${formatMmss(run.endSample, sampleRate)}`}
                  style={{
                    width: `${Math.round(run.widthPercent * 1000) / 1000}%`,
                    backgroundColor: clusterColor(run.cluster),
                  }}
                />
              ))}
            </div>

            <div>
              <FieldLabel htmlFor="remix-bpm">Tempo (BPM)</FieldLabel>
              <div className="flex items-center gap-1">
                <GlassField
                  id="remix-bpm"
                  type="number"
                  data-testid="remix-bpm"
                  value={bpmDraft}
                  disabled={busy}
                  onChange={(e) => setBpmDraft(e.target.value)}
                  className="w-24"
                  style={{ width: 96 }}
                />
                <GlassButton
                  data-testid="remix-redetect"
                  onClick={() => void applyTypedBpm()}
                  disabled={busy}
                  style={CHIP}
                >
                  Re-detect
                </GlassButton>
                <GlassButton
                  data-testid="remix-double"
                  title="Double tempo (x2) — re-tracks the beat grid"
                  onClick={() => void regridAndDerive(analysis.periodFrames / 2)}
                  disabled={busy}
                  style={CHIP}
                >
                  x2
                </GlassButton>
                <GlassButton
                  data-testid="remix-halve"
                  title="Halve tempo (/2) — re-tracks the beat grid"
                  onClick={() => void regridAndDerive(analysis.periodFrames * 2)}
                  disabled={busy}
                  style={CHIP}
                >
                  /2
                </GlassButton>
              </div>
            </div>

            <div className="flex gap-2">
              <div className="flex-1">
                <FieldLabel htmlFor="remix-meter">Time signature</FieldLabel>
                <GlassSelect
                  id="remix-meter"
                  data-testid="remix-meter"
                  value={meterLabel(beatsPerBar)}
                  disabled={busy}
                  onChange={(e) => {
                    const next = METERS.find((m) => m.value === e.target.value)?.beatsPerBar ?? 4;
                    setBeatsPerBar(next);
                    rederive(next, downbeatShift);
                  }}
                >
                  {METERS.map((m) => (
                    <option key={m.value} value={m.value}>
                      {m.value}
                    </option>
                  ))}
                </GlassSelect>
              </div>
              <div>
                <FieldLabel>{`Downbeat (${downbeatShift >= 0 ? '+' : ''}${downbeatShift})`}</FieldLabel>
                <div className="flex gap-1">
                  <GlassButton
                    data-testid="remix-downbeat-prev"
                    aria-label="Shift downbeat one beat earlier"
                    onClick={() => {
                      const next = downbeatShift - 1;
                      setDownbeatShift(next);
                      rederive(beatsPerBar, next);
                    }}
                    disabled={busy}
                    style={{ padding: '5px 8px' }}
                  >
                    <ChevronLeft size={14} />
                  </GlassButton>
                  <GlassButton
                    data-testid="remix-downbeat-next"
                    aria-label="Shift downbeat one beat later"
                    onClick={() => {
                      const next = downbeatShift + 1;
                      setDownbeatShift(next);
                      rederive(beatsPerBar, next);
                    }}
                    disabled={busy}
                    style={{ padding: '5px 8px' }}
                  >
                    <ChevronRight size={14} />
                  </GlassButton>
                </div>
              </div>
            </div>

            <label className="flex items-center gap-2 text-xs" style={{ color: 'var(--glass-text-label)' }}>
              <input
                type="checkbox"
                data-testid="remix-tempo-confirmed"
                checked={tempoConfirmed}
                onChange={(e) => setTempoConfirmed(e.target.checked)}
                className="accent-[#26c6da]"
              />
              Tempo and downbeat are correct
            </label>

            <SectionLabel>Target</SectionLabel>

            <div>
              <FieldLabel htmlFor="remix-target">Target length</FieldLabel>
              <div className="flex items-center gap-2">
                <GlassSlider
                  className="flex-1"
                  data-testid="remix-target-slider"
                  min={plan ? plan.minOutputSample : 0}
                  max={plan ? plan.maxOutputSample : 0}
                  step={sampleRate}
                  value={targetSample ?? 0}
                  onChange={(e) => commitTargetSamples(Number(e.target.value))}
                />
                <GlassField
                  id="remix-target"
                  type="text"
                  data-testid="remix-target"
                  value={targetDraft}
                  onChange={(e) => handleTargetText(e.target.value)}
                  className="w-20 font-mono"
                  style={{ width: 80 }}
                />
              </div>
              {plan && plan.ok && (
                <p
                  data-testid="remix-will-produce"
                  className="mt-1 text-xs"
                  style={{ color: 'var(--glass-text-label)' }}
                >
                  {`→ will produce ${formatMmss(plan.outputSample, sampleRate)} (nearest phrase)`}
                </p>
              )}
            </div>

            <SectionLabel>Options</SectionLabel>

            <div className="flex gap-2">
              <div className="flex-1">
                <FieldLabel htmlFor="remix-crossfade">Crossfade (ms)</FieldLabel>
                <GlassField
                  id="remix-crossfade"
                  type="number"
                  data-testid="remix-crossfade"
                  min={5}
                  max={120}
                  value={crossfadeMs}
                  onChange={(e) => setCrossfadeMs(Number(e.target.value))}
                />
                {crossfadeCapped && (
                  <p
                    data-testid="remix-crossfade-capped"
                    className="mt-1 text-xs"
                    title="A crossfade wider than a quarter of the beat period would smear across the beat, so the renderer caps it there. Individual edits at the very start or end of the source can be narrower still."
                    style={{ color: 'var(--glass-text-label)' }}
                  >
                    {`→ applies ${appliedCrossfadeMs} ms (quarter-beat cap)`}
                  </p>
                )}
              </div>
              <div className="flex-1">
                <FieldLabel htmlFor="remix-phrase">Phrase length (bars)</FieldLabel>
                <GlassSelect
                  id="remix-phrase"
                  data-testid="remix-phrase"
                  value={String(phraseBars)}
                  onChange={(e) => setPhraseBars(Number(e.target.value))}
                >
                  <option value="4">4</option>
                  <option value="8">8</option>
                  <option value="16">16</option>
                </GlassSelect>
              </div>
              <div className="flex-1">
                <FieldLabel htmlFor="remix-strictness">Phrase strictness</FieldLabel>
                <GlassSelect
                  id="remix-strictness"
                  data-testid="remix-strictness"
                  value={strict ? 'strict' : 'loose'}
                  onChange={(e) => setStrict(e.target.value === 'strict')}
                >
                  <option value="strict">Strict</option>
                  <option value="loose">Loose</option>
                </GlassSelect>
              </div>
            </div>

            <label className="flex items-center gap-2 text-xs" style={{ color: 'var(--glass-text-label)' }}>
              <input
                type="checkbox"
                data-testid="remix-allow-repeats"
                checked={allowRepeats}
                onChange={(e) => setAllowRepeats(e.target.checked)}
                className="accent-[#26c6da]"
              />
              Allow repeats
            </label>
            <label className="flex items-center gap-2 text-xs" style={{ color: 'var(--glass-text-label)' }}>
              <input
                type="checkbox"
                data-testid="remix-mark-edits"
                checked={markEditPoints}
                onChange={(e) => setMarkEditPoints(e.target.checked)}
                className="accent-[#26c6da]"
              />
              Mark edit points
            </label>
            <label className="flex items-center gap-2 text-xs" style={{ color: 'var(--glass-text-label)' }}>
              <input
                type="checkbox"
                data-testid="remix-exact-length"
                checked={exactLength}
                onChange={(e) => setExactLength(e.target.checked)}
                className="accent-[#26c6da]"
              />
              Exact length (trims the final decay)
            </label>
          </>
        )}

        {hint && (
          <p data-testid="remix-hint" className="text-xs text-[#e0a458]">
            {hint}
          </p>
        )}

        {error && (
          <p data-testid="remix-error" className="text-xs text-[#ef5350]">
            {error}
          </p>
        )}

        {creating && (
          <div>
            <p className="mb-1 text-xs" style={{ color: 'var(--glass-text-muted)' }}>
              Building the remix…
            </p>
            <div
              className="h-1.5 w-full overflow-hidden rounded-full"
              style={{
                background: 'rgba(255, 255, 255, 0.09)',
                boxShadow: 'inset 0 1px 2px rgba(0, 0, 0, 0.6)',
              }}
            >
              <div
                data-testid="remix-create-progress"
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
          {/* U2-3: disabled while a pass is in flight, matching the seven other
              pipeline tools. `dismissable` stops Escape, the backdrop and the
              module column's ✕ mid-pass, but it cannot govern a button inside
              this body — so without this, the one control still live was the
              one that unmounted the dialog and made `cancelledRef` throw the
              finished remix away. */}
          <GlassButton data-testid="remix-cancel" onClick={onClose} disabled={busy}>
            Cancel
          </GlassButton>
          <GlassButton
            variant="primary"
            onClick={() => void handleCreate()}
            disabled={!canCreate}
          >
            Create Remix
          </GlassButton>
        </div>
      </div>
    </DialogShell>
  );
}
