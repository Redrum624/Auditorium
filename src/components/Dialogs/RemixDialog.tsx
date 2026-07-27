import { useEffect, useMemo, useRef, useState } from 'react';
import { useAppStore } from '../../stores/appStore';
import { parseTime } from '../../utils/timeFormat';
import { CONFIDENCE_LOW } from '../../dsp/tempoCore';
import { DEFAULT_REMIX_WEIGHTS } from '../../dsp/remixCost';
import { deriveRemixFeatures, type RemixAnalysis } from '../../dsp/remixFeatures';
import {
  DEFAULT_MAX_REPEAT_FACTOR,
  planRemix,
  type PlanRemixOptions,
  type PlanRemixResult,
} from '../../dsp/remixPlan';
import { regridTempo, runRemixAnalysis, setRemixAnalysis } from '../../services/tempoAnalysis';
import { createRemixDocument } from '../../services/remixService';
import { focusRemixPanel } from '../../services/dialogBus';
import DialogShell from './DialogShell';

const FIELD =
  'w-full rounded border border-[#3a3a42] bg-[#2e2e34] px-2 py-1 text-sm text-[#d4d4d8] focus:border-[#26c6da] focus:outline-none';
const LABEL = 'mb-1 block text-xs text-[#8b8b92]';

const ANALYSIS_FAILED = 'Beat analysis did not produce a usable grid for this document.';

/** One colour per cluster label, cycled — the structure strip's only job is to
 * make "these bars belong together" legible before the user commits. */
const CLUSTER_COLORS = ['#26c6da', '#e0a458', '#7e57c2', '#66bb6a', '#ef5350', '#42a5f5'];

const METERS: { value: string; beatsPerBar: number }[] = [
  { value: '3/4', beatsPerBar: 3 },
  { value: '4/4', beatsPerBar: 4 },
  { value: '6/8', beatsPerBar: 6 },
];

/** `m:ss` — the coarse grain every length in this dialog is expressed in
 * (durations are bar-quantised anyway, so milliseconds would be noise). */
function formatMmss(samples: number, sampleRate: number): string {
  const total = Number.isFinite(samples) ? Math.max(0, Math.round(samples / sampleRate)) : 0;
  const minutes = Math.floor(total / 60);
  return `${minutes}:${String(total - minutes * 60).padStart(2, '0')}`;
}

function meterLabel(beatsPerBar: number): string {
  return METERS.find((m) => m.beatsPerBar === beatsPerBar)?.value ?? `${beatsPerBar}/4`;
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

interface StructureRun {
  cluster: number;
  startSample: number;
  endSample: number;
  widthPercent: number;
}

/** One block per MAXIMAL RUN of consecutive bars sharing a cluster label. Bar
 * `m` spans `[barBoundary[m], barBoundary[m+1])` and is labelled `cluster[m]`,
 * so a run's duration is the distance between the first and last boundary it
 * covers and the widths sum to 100%. */
function structureRuns(analysis: RemixAnalysis | null): StructureRun[] {
  if (!analysis || analysis.numBars < 1) return [];
  const { barBoundary, cluster, numBars } = analysis;
  if (barBoundary.length < numBars + 1 || cluster.length < numBars) return [];
  const total = barBoundary[numBars] - barBoundary[0];
  if (!(total > 0)) return [];

  const runs: StructureRun[] = [];
  let start = 0;
  for (let bar = 1; bar <= numBars; bar++) {
    if (bar === numBars || cluster[bar] !== cluster[start]) {
      const startSample = barBoundary[start];
      const endSample = barBoundary[bar];
      runs.push({
        cluster: cluster[start],
        startSample,
        endSample,
        widthPercent: ((endSample - startSample) / total) * 100,
      });
      start = bar;
    }
  }
  return runs;
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

  // A tempo the USER asserted clears the planner's own confidence gate
  // (`remixPlan.ts`: `confidence < CONFIDENCE_LOW -> 'no-tempo'`). That gate
  // measures how strongly the ACF backed the detected period; once the user
  // has confirmed or typed the tempo, that measurement is no longer what
  // decides whether a remix may be planned — which is exactly what the plan's
  // own "Enter a BPM manually to continue" instruction promises. Raised to the
  // threshold, never above it.
  const effectiveAnalysis = useMemo(() => {
    if (!analysis) return null;
    if (!tempoConfirmed || analysis.confidence >= CONFIDENCE_LOW) return analysis;
    return { ...analysis, confidence: CONFIDENCE_LOW };
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
   * `createRemixDocument` plans against exactly what is on screen. */
  function publish(next: RemixAnalysis, tempoAsserted: boolean): void {
    setAnalysis(next);
    setError(null);
    const live = liveDoc();
    if (live && live.id === docId) setRemixAnalysis(live, next);
    if (next.bpm !== null) setBpmDraft(next.bpm.toFixed(1));
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
    <DialogShell title="Auto-Remix" onClose={onClose} dismissable={!busy}>
      <div className="flex max-h-[70vh] flex-col gap-3 overflow-auto" data-testid="remix-dialog">
        {analysing && (
          <div>
            <p className="mb-1 text-xs text-[#8b8b92]">Analyzing beat grid…</p>
            <div className="h-1.5 w-full overflow-hidden rounded bg-[#2e2e34]">
              <div
                data-testid="remix-progress"
                className="h-full bg-[#26c6da] transition-[width]"
                style={{ width: `${Math.round(progress * 100)}%` }}
              />
            </div>
          </div>
        )}

        {analysis && (
          <>
            <div className="flex items-baseline justify-between gap-2">
              <span data-testid="remix-summary" className="text-sm text-[#d4d4d8]">
                {`${analysis.bpm !== null ? analysis.bpm.toFixed(1) : '—'} BPM · ${meterLabel(
                  analysis.beatsPerBar
                )} · ${analysis.numBars} bars`}
              </span>
              <span data-testid="remix-confidence" className="text-xs text-[#8b8b92]">
                {`${'●'.repeat(Math.max(0, Math.min(5, Math.round(analysis.confidence * 5))))}${'○'.repeat(
                  5 - Math.max(0, Math.min(5, Math.round(analysis.confidence * 5)))
                )} ${analysis.confidence.toFixed(2)}`}
              </span>
            </div>

            <div className="flex h-4 w-full overflow-hidden rounded" data-testid="remix-structure">
              {runs.map((run, i) => (
                <div
                  key={i}
                  data-testid="remix-structure-block"
                  title={`${formatMmss(run.startSample, sampleRate)} – ${formatMmss(run.endSample, sampleRate)}`}
                  style={{
                    width: `${Math.round(run.widthPercent * 1000) / 1000}%`,
                    backgroundColor: CLUSTER_COLORS[((run.cluster % CLUSTER_COLORS.length) + CLUSTER_COLORS.length) % CLUSTER_COLORS.length],
                  }}
                />
              ))}
            </div>

            <div>
              <label className={LABEL} htmlFor="remix-bpm">
                Tempo (BPM)
              </label>
              <div className="flex items-center gap-1">
                <input
                  id="remix-bpm"
                  type="number"
                  data-testid="remix-bpm"
                  value={bpmDraft}
                  disabled={busy}
                  onChange={(e) => setBpmDraft(e.target.value)}
                  className={`${FIELD} w-24`}
                />
                <button
                  type="button"
                  data-testid="remix-redetect"
                  onClick={() => void applyTypedBpm()}
                  disabled={busy}
                  className="rounded border border-[#3a3a42] px-1 text-xs text-[#d4d4d8] hover:border-[#26c6da] disabled:opacity-50"
                >
                  Re-detect
                </button>
                <button
                  type="button"
                  data-testid="remix-double"
                  title="Double tempo (x2) — re-tracks the beat grid"
                  onClick={() => void regridAndDerive(analysis.periodFrames / 2)}
                  disabled={busy}
                  className="rounded border border-[#3a3a42] px-1 text-xs text-[#d4d4d8] hover:border-[#26c6da] disabled:opacity-50"
                >
                  x2
                </button>
                <button
                  type="button"
                  data-testid="remix-halve"
                  title="Halve tempo (/2) — re-tracks the beat grid"
                  onClick={() => void regridAndDerive(analysis.periodFrames * 2)}
                  disabled={busy}
                  className="rounded border border-[#3a3a42] px-1 text-xs text-[#d4d4d8] hover:border-[#26c6da] disabled:opacity-50"
                >
                  /2
                </button>
              </div>
            </div>

            <div className="flex gap-2">
              <div className="flex-1">
                <label className={LABEL} htmlFor="remix-meter">
                  Time signature
                </label>
                <select
                  id="remix-meter"
                  data-testid="remix-meter"
                  className={FIELD}
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
                </select>
              </div>
              <div>
                <span className={LABEL}>{`Downbeat (${downbeatShift >= 0 ? '+' : ''}${downbeatShift})`}</span>
                <div className="flex gap-1">
                  <button
                    type="button"
                    data-testid="remix-downbeat-prev"
                    onClick={() => {
                      const next = downbeatShift - 1;
                      setDownbeatShift(next);
                      rederive(beatsPerBar, next);
                    }}
                    disabled={busy}
                    className="rounded border border-[#3a3a42] px-2 py-1 text-sm text-[#d4d4d8] hover:border-[#26c6da] disabled:opacity-50"
                  >
                    ◂
                  </button>
                  <button
                    type="button"
                    data-testid="remix-downbeat-next"
                    onClick={() => {
                      const next = downbeatShift + 1;
                      setDownbeatShift(next);
                      rederive(beatsPerBar, next);
                    }}
                    disabled={busy}
                    className="rounded border border-[#3a3a42] px-2 py-1 text-sm text-[#d4d4d8] hover:border-[#26c6da] disabled:opacity-50"
                  >
                    ▸
                  </button>
                </div>
              </div>
            </div>

            <label className="flex items-center gap-2 text-xs text-[#d4d4d8]">
              <input
                type="checkbox"
                data-testid="remix-tempo-confirmed"
                checked={tempoConfirmed}
                onChange={(e) => setTempoConfirmed(e.target.checked)}
                className="accent-[#26c6da]"
              />
              Tempo and downbeat are correct
            </label>

            <div>
              <label className={LABEL} htmlFor="remix-phrase">
                Phrase length (bars)
              </label>
              <select
                id="remix-phrase"
                data-testid="remix-phrase"
                className={FIELD}
                value={String(phraseBars)}
                onChange={(e) => setPhraseBars(Number(e.target.value))}
              >
                <option value="4">4</option>
                <option value="8">8</option>
                <option value="16">16</option>
              </select>
            </div>

            <div>
              <label className={LABEL} htmlFor="remix-target">
                Target length
              </label>
              <div className="flex items-center gap-2">
                <input
                  type="range"
                  data-testid="remix-target-slider"
                  min={plan ? plan.minOutputSample : 0}
                  max={plan ? plan.maxOutputSample : 0}
                  step={sampleRate}
                  value={targetSample ?? 0}
                  onChange={(e) => commitTargetSamples(Number(e.target.value))}
                  className="flex-1 accent-[#26c6da]"
                />
                <input
                  id="remix-target"
                  type="text"
                  data-testid="remix-target"
                  value={targetDraft}
                  onChange={(e) => handleTargetText(e.target.value)}
                  className={`${FIELD} w-20`}
                />
              </div>
              {plan && plan.ok && (
                <p data-testid="remix-will-produce" className="mt-1 text-xs text-[#d4d4d8]">
                  {`→ will produce ${formatMmss(plan.outputSample, sampleRate)} (nearest phrase)`}
                </p>
              )}
            </div>

            <div className="flex gap-2">
              <div className="flex-1">
                <label className={LABEL} htmlFor="remix-crossfade">
                  Crossfade (ms)
                </label>
                <input
                  id="remix-crossfade"
                  type="number"
                  data-testid="remix-crossfade"
                  min={5}
                  max={120}
                  value={crossfadeMs}
                  onChange={(e) => setCrossfadeMs(Number(e.target.value))}
                  className={FIELD}
                />
              </div>
              <div className="flex-1">
                <label className={LABEL} htmlFor="remix-strictness">
                  Phrase strictness
                </label>
                <select
                  id="remix-strictness"
                  data-testid="remix-strictness"
                  className={FIELD}
                  value={strict ? 'strict' : 'loose'}
                  onChange={(e) => setStrict(e.target.value === 'strict')}
                >
                  <option value="strict">Strict</option>
                  <option value="loose">Loose</option>
                </select>
              </div>
            </div>

            <label className="flex items-center gap-2 text-xs text-[#d4d4d8]">
              <input
                type="checkbox"
                data-testid="remix-allow-repeats"
                checked={allowRepeats}
                onChange={(e) => setAllowRepeats(e.target.checked)}
                className="accent-[#26c6da]"
              />
              Allow repeats
            </label>
            <label className="flex items-center gap-2 text-xs text-[#d4d4d8]">
              <input
                type="checkbox"
                data-testid="remix-mark-edits"
                checked={markEditPoints}
                onChange={(e) => setMarkEditPoints(e.target.checked)}
                className="accent-[#26c6da]"
              />
              Mark edit points
            </label>
            <label className="flex items-center gap-2 text-xs text-[#d4d4d8]">
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
            <p className="mb-1 text-xs text-[#8b8b92]">Building the remix…</p>
            <div className="h-1.5 w-full overflow-hidden rounded bg-[#2e2e34]">
              <div
                data-testid="remix-create-progress"
                className="h-full bg-[#26c6da] transition-[width]"
                style={{ width: `${Math.round(progress * 100)}%` }}
              />
            </div>
          </div>
        )}

        <div className="mt-2 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded border border-[#3a3a42] bg-[#2e2e34] px-3 py-1 text-sm text-[#d4d4d8] hover:bg-[#3a3a42]"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void handleCreate()}
            disabled={!canCreate}
            className="rounded bg-[#26c6da] px-3 py-1 text-sm font-medium text-[#101014] hover:brightness-110 disabled:opacity-50"
          >
            Create Remix
          </button>
        </div>
      </div>
    </DialogShell>
  );
}
