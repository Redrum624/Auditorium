import { useEffect, useRef, useState } from 'react';
import { docLength } from '../../audio/AudioDocument';
import { formatTime } from '../../utils/timeFormat';
import { useAppStore, type SelectionRange } from '../../stores/appStore';
import {
  getTempo,
  regridTempo,
  runTempoAnalysis,
  type TempoEntry,
} from '../../services/tempoAnalysis';
import {
  applyTempoChange,
  checkTempoChange,
  checkVariableTempoChange,
  detectRegionTempo,
  tempoQualityBand,
  tempoRatio,
  MAX_BEAT_MARKERS,
  type RegionTempoDetection,
  type TempoRefusal,
} from '../../services/tempoService';
import { resolveRegion } from '../../services/selectionRegion';
import { CONFIDENCE_LOW } from '../../dsp/tempoCore';
import { MIN_RATIO, MAX_RATIO } from '../../dsp/wsola';
import { Gauge } from 'lucide-react';
import { FieldLabel, GlassButton, GlassField, GlassSelect, SectionLabel } from '../UI/glass';
import DialogShell from './DialogShell';

/** Small chip-sized GlassButton geometry (the mockup's `.chip`). */
const CHIP = { padding: '2px 8px', fontSize: 11 } as const;

type Mode = 'bpm' | 'percent';

/**
 * R7 — how the correction is applied across the region.
 *
 * `'one-ratio'` is the DEFAULT and is today's behaviour, byte for byte: one
 * ratio for the whole region. `'follow-beats'` builds a tempo map from the
 * confirmed grid and corrects beat by beat. Opt-in, because a user who reached
 * for Match Tempo on a steady loop does not want per-bar correction applied to
 * it — and because a wrong tempo map is wrong differently in every bar, which
 * is far harder to hear than a uniformly wrong ratio and impossible to undo by
 * ear. So the variable path is entered deliberately, against a grid the user
 * has confirmed (RULING 1).
 */
type Correction = 'one-ratio' | 'follow-beats';

/** A lightweight view over either a doc-scoped `TempoEntry` (cache read) or an
 * ad-hoc `RegionTempoDetection` (`detectRegionTempo`) -- whichever is
 * currently driving the display. */
interface DisplayEstimate {
  bpm: number | null;
  confidence: number;
  stale: boolean;
}

function toDisplay(entry: TempoEntry | null): DisplayEstimate | null {
  return entry ? { bpm: entry.bpm, confidence: entry.confidence, stale: entry.stale } : null;
}

function toDisplayRegion(region: RegionTempoDetection | null): DisplayEstimate | null {
  return region ? { bpm: region.bpm, confidence: region.confidence, stale: false } : null;
}

function sameSelection(a: SelectionRange | null, b: SelectionRange | null): boolean {
  if (a === null || b === null) return a === b;
  return a.start === b.start && a.end === b.end;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** `m:ss.d` (tenths of a second) for the whole-file scope line -- a coarser
 * grain than `formatTime`'s `m:ss.mmm`, matching the brief's own example
 * ('Whole file — 3:41.2'). */
function formatWholeFileDuration(totalSeconds: number): string {
  const safe = Number.isFinite(totalSeconds) ? Math.max(0, totalSeconds) : 0;
  const minutes = Math.floor(safe / 60);
  const secs = safe - minutes * 60;
  return `${minutes}:${secs.toFixed(1).padStart(4, '0')}`;
}

function firstBeatAtOrAfter(beatSamples: Int32Array, start: number): number | null {
  for (let i = 0; i < beatSamples.length; i++) {
    if (beatSamples[i] >= start) return beatSamples[i];
  }
  return null;
}

function refusalMessage(reason: TempoRefusal | undefined): string {
  switch (reason) {
    case 'no-op':
      return 'Target equals source tempo.';
    case 'invalid-bpm':
      return 'Enter a valid source and target tempo.';
    case 'out-of-range':
      return 'Target tempo is out of the supported range.';
    case 'no-grid':
      return 'The confirmed beat grid has fewer than two beats in this region.';
    case 'empty-region':
      return 'The selected region is empty.';
    case 'no-document':
      return 'No document is open.';
    case 'cancelled':
      // T6-3. Unreachable from THIS dialog by construction — a cancelled pass is
      // one whose tool is already gone, so `handleApply` returns before it can
      // set an error line — and it is written anyway because the reason is part
      // of the service's contract, and `testHooks` reads the same outcome.
      // Without an arm of its own it would fall to the default, which says the
      // change "did not apply" as though something had gone wrong.
      return 'The tempo change was cancelled. Nothing was changed.';
    default:
      return 'The tempo change did not apply.';
  }
}

/**
 * Feature 2 UI (Task T8): Match Tempo dialog. Minimal per Plan Ruling 1 --
 * required fields, a confirm button, an error line -- EXCEPT the x2//2
 * octave-correction control, which the T2 carry-forward / plan amendment
 * (2026-07-26) makes mandatory and exempt from that ruling: confidence cannot
 * gate octave errors (a half-tempo detection can score the HIGHEST confidence
 * in the whole fixture bank), so this dialog must offer the same
 * `regridTempo`-backed correction PropertiesPanel's TempoSection (T5) already
 * does -- never a local relabel, since `beatSamples` at the wrong octave
 * physically contains only every other beat.
 *
 * The estimate lives entirely in local React state (no `useTempoVersion`, no
 * new sidebar hook): `getTempo(doc)` is read ONCE, in a lazy initializer, so
 * opening this dialog never triggers analysis on its own (Ruling 2.3).
 */
export default function TempoDialog({ onClose }: { onClose: () => void }) {
  const doc = useAppStore((s) => s.documents.find((d) => d.id === s.activeDocumentId) ?? null);
  const selection = useAppStore((s) => s.selection);

  // Captured ONCE per mount (never re-run automatically): the doc-scoped
  // cached entry (never starts a worker) and, when a selection already
  // exists, an immediate selection-scoped re-detect -- Ruling 2.9's "re-detect
  // from selection is the default whenever a selection exists" -- via the
  // synchronous, uncached `detectRegionTempo` (NOT `runTempoAnalysis`, so this
  // does not violate "never triggers analysis on open").
  const [initial] = useState(() => ({
    docEntry: doc ? getTempo(doc) : null,
    regionOverride: selection ? detectRegionTempo() : null,
  }));

  const [docEntry, setDocEntry] = useState<TempoEntry | null>(() => initial.docEntry);
  const [regionOverride, setRegionOverride] = useState<RegionTempoDetection | null>(
    () => initial.regionOverride
  );
  const [lastEstimateSelection, setLastEstimateSelection] = useState<SelectionRange | null>(
    () => selection
  );
  const [detecting, setDetecting] = useState(false);
  const [correctionFailed, setCorrectionFailed] = useState(false);

  const [sourceDraft, setSourceDraft] = useState<string>(() => {
    const est = toDisplayRegion(initial.regionOverride) ?? toDisplay(initial.docEntry);
    return est?.bpm != null ? String(est.bpm) : '';
  });
  const [mode, setMode] = useState<Mode>('bpm');
  const [targetBpmDraft, setTargetBpmDraft] = useState('');
  const [percentDraft, setPercentDraft] = useState('');
  const [addBeatMarkers, setAddBeatMarkers] = useState(false);
  // R7. `correction` defaults to today's behaviour; `gridConfirmed` is RULING
  // 1's gate and is cleared by every action that changes the grid, so it can
  // never outlive the thing it confirmed (F9's `AlignTimingDialog` precedent).
  const [correction, setCorrection] = useState<Correction>('one-ratio');
  const [gridConfirmed, setGridConfirmed] = useState(false);

  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [applyError, setApplyError] = useState<string | null>(null);

  const sourceInputRef = useRef<HTMLInputElement>(null);

  /**
   * T6-3 — the unmount guard this dialog did not have.
   *
   * U2's fix round found the claim that "all nine discard on unmount" false:
   * seven do, and this one guarded only a DOM ref, so an Apply that resolved
   * after the tool was gone committed its stretch, its marker correction and its
   * beat grid into a document the user had walked away from. The module lock has
   * been holding the app still to prevent that; this is the discipline it was
   * standing in for.
   *
   * A ref rather than state, for the reason `CoverChainDialog` records: the
   * cleanup has to read the CURRENT value, and a state variable captured in a
   * closure is the value at the last render. Reset on mount as well as set on
   * unmount, because StrictMode mounts twice and a ref survives the remount.
   */
  const cancelledRef = useRef(false);
  useEffect(() => {
    cancelledRef.current = false;
    return () => {
      cancelledRef.current = true;
    };
  }, []);

  // Low-confidence focus (spec item 2): only on the INITIAL estimate, once.
  useEffect(() => {
    const est = toDisplayRegion(initial.regionOverride) ?? toDisplay(initial.docEntry);
    if (est && est.bpm !== null && est.confidence < CONFIDENCE_LOW) {
      sourceInputRef.current?.focus();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!doc) return null;

  const display = toDisplayRegion(regionOverride) ?? toDisplay(docEntry);
  // Gated on `!stale` too (not just bpm/length): a stale grid describes
  // audio from BEFORE an edit that happened since caching, so laying beat
  // markers down from it onto the post-stretch document would silently
  // misplace them -- the exact "stale grid reaches a consumer" hazard Plan
  // Ruling 3 calls out as the one failure mode in this release that produces
  // silently wrong output rather than a visible error.
  const hasBeatPhase =
    docEntry !== null && docEntry.bpm !== null && !docEntry.stale && docEntry.beatSamples.length > 0;
  const selectionChanged = !sameSelection(lastEstimateSelection, selection);

  // Resolved through the SAME clamp `tempoService` (and therefore `cloneRegion`)
  // applies, so what this dialog measures and what Apply acts on cannot describe
  // different audio. T6-1: literally the same function now, not the same two
  // expressions typed out again — this was the view-layer copy of six.
  //
  // The premise is unreachable — no UI path produces an out-of-bounds selection
  // (the editor gestures clamp, select-all uses `docLength`) — and the earlier
  // justification for leaving it unclamped, that these values are "display
  // only", was simply wrong: `beatsInRegion` below gates the Correction select
  // and `variableCheck`, and `regionStart` feeds `firstBeatAtOrAfter` for
  // `firstBeatSample`. Neither is display. What is true is that both are
  // INSENSITIVE to the clamp rather than unused: every element of `beatSamples`
  // lies in `[0, docLength)`, so moving `start` into `[0, len]` cannot change
  // which beats satisfy `regionStart <= b < regionEnd`, nor which is the first
  // at or after it. Clamped anyway, because "insensitive today" is a property of
  // the consumers and not of the value.
  const { start: regionStart, end: regionEnd } = resolveRegion(doc, selection);
  const regionSeconds = (regionEnd - regionStart) / doc.sampleRate;

  const scopeText = selection
    ? `Selection — ${formatTime(selection.start, doc.sampleRate)} → ${formatTime(selection.end, doc.sampleRate)} (${regionSeconds.toFixed(2)} s)`
    : `Whole file — ${formatWholeFileDuration(docLength(doc) / doc.sampleRate)}`;

  const sourceNum = Number(sourceDraft);
  const validSource = Number.isFinite(sourceNum) && sourceNum > 0;

  const targetNum =
    mode === 'bpm'
      ? Number(targetBpmDraft)
      : validSource && Number(percentDraft) > 0
        ? (sourceNum * 100) / Number(percentDraft)
        : NaN;
  const validTarget = Number.isFinite(targetNum) && targetNum > 0;

  const check = validSource && validTarget ? checkTempoChange({ sourceBpm: sourceNum, targetBpm: targetNum }) : null;
  const ratio = check?.ok ? check.ratio : validSource && validTarget ? tempoRatio(sourceNum, targetNum) : null;

  // v1.9.1 item 2: a no-op ratio (source === target) normally disables Apply,
  // but if the user has ticked "Add beat markers" (only possible when a beat
  // phase exists), applying lays the grid at the CURRENT tempo with no stretch.
  // The service (`applyTempoChange` -> `layBeatGridAtCurrentTempo`) enforces the
  // "no stretch at ratio 1" half; this only re-enables the button for it.
  const noOpWithMarkers =
    check !== null && !check.ok && check.reason === 'no-op' && addBeatMarkers && hasBeatPhase;

  // R7. The variable path needs a fresh, own-analysis grid with at least two
  // beats INSIDE the region — one measured interval is the minimum from which a
  // local tempo can be read at all. `hasBeatPhase` already carries the
  // fresh-and-own half (a stale grid describes pre-edit audio).
  // Held as the ARRAY rather than as a boolean so every use below is narrowed
  // by construction: there is no path on which the variable request is built
  // from a grid this dialog has not established is present and fresh.
  const confirmableGrid: Int32Array | null = hasBeatPhase && docEntry ? docEntry.beatSamples : null;
  const beatsInRegion = confirmableGrid
    ? Array.from(confirmableGrid).filter((b) => b >= regionStart && b < regionEnd).length
    : 0;
  const canFollowBeats = beatsInRegion >= 2;
  const variableCheck =
    correction === 'follow-beats' && confirmableGrid !== null && canFollowBeats && validTarget
      ? checkVariableTempoChange({
          sourceBpm: sourceNum,
          targetBpm: targetNum,
          variableRate: { beatSamples: confirmableGrid },
        })
      : null;
  const variablePlan = variableCheck?.ok ? variableCheck.plan : null;

  const canApply =
    correction === 'follow-beats'
      ? !busy && gridConfirmed && variablePlan !== null
      : validSource && validTarget && !busy && ((check !== null && check.ok) || noOpWithMarkers);

  async function handleDetect() {
    if (!doc || detecting) return;
    setDetecting(true);
    try {
      const result = await runTempoAnalysis(doc);
      // T6-3: an analysis that lands after the tool is gone is a warmed CACHE,
      // keyed by document — not an edit, not undoable, and correct for the
      // document it measured. So the run is deliberately left to finish, and
      // only the setState below is guarded. That guard is HYGIENE, not a fix:
      // as of React 19 a setState after unmount is a silent no-op, so deleting
      // it changes nothing observable and no test pins it (proven by mutation —
      // the suite stayed green). It stays because reading "return early once
      // this component is gone" at every await is what makes the ONE guard that
      // does matter, in `handleApply`, unremarkable rather than a special case.
      if (cancelledRef.current) return;
      setDocEntry(result);
      setRegionOverride(null);
      setCorrectionFailed(false);
      // Kept for correctness, but UNREACHABLE WITH EFFECT today, and that is
      // recorded rather than papered over with a test that reaches it through
      // internals a user cannot touch.
      //
      // The argument is about `docEntry`'s TRANSITIONS, not about what renders
      // now. An earlier version of this comment reasoned from the render gate —
      // "the tick never renders in this state" — which does not close: this
      // function runs asynchronously and `gridConfirmed` is persistent state, so
      // what renders at THIS moment says nothing about whether an earlier render
      // set it. What actually closes it is the property that comment disclaimed,
      // and it holds more strongly than "one-way":
      //
      //  - `setDocEntry` has exactly two call sites, the line above and the one
      //    in `correctOctave`. `correctOctave`'s is inside `result && result.bpm
      //    !== null`, so it never passes null.
      //  - The line above CAN pass null, but `handleDetect` is called from one
      //    place only, the Detect button, which renders solely while
      //    `docEntry === null`.
      //
      // So NO non-null → null transition of `docEntry` exists at all, and
      // `gridConfirmed` can only be set by a checkbox that requires a non-null
      // `docEntry` to render. `handleDetect` can therefore never run while
      // `gridConfirmed` is true.
      //
      // It stays because this call REPLACES the grid, so the moment a second
      // caller or a wider render gate breaks either premise the reset becomes
      // load-bearing — and the gate is pinned by test in both states so that
      // widening cannot pass unnoticed.
      setGridConfirmed(false);
      setLastEstimateSelection(useAppStore.getState().selection);
      if (result?.bpm != null) setSourceDraft(String(result.bpm));
    } finally {
      if (!cancelledRef.current) setDetecting(false);
    }
  }

  function handleRedetectFromSelection() {
    const result = detectRegionTempo();
    setRegionOverride(result);
    setCorrectionFailed(false);
    setGridConfirmed(false);
    setLastEstimateSelection(useAppStore.getState().selection);
    if (result?.bpm != null) setSourceDraft(String(result.bpm));
  }

  // x2//2 MUST call `regridTempo` -- never a local relabel (T2 carry-forward,
  // binding). 'x2' halves periodFrames (higher tempo -> shorter period); '/2'
  // doubles it -- the exact convention PropertiesPanel's TempoSection (T5)
  // already established.
  async function correctOctave(periodMultiplier: 2 | 0.5) {
    if (!doc || !docEntry || docEntry.bpm === null) return;
    setCorrectionFailed(false);
    // A ×2 / ÷2 re-track replaces the beat positions themselves, so any earlier
    // confirmation described a grid that no longer exists (RULING 1).
    setGridConfirmed(false);
    const newPeriodFrames = docEntry.periodFrames / periodMultiplier;
    const result = await regridTempo(doc.id, newPeriodFrames);
    // Same reading as `handleDetect`: a re-track writes the analysis cache for
    // the document it re-tracked, never the document itself. See the concern
    // recorded in the T6 report — the cache write itself is not cancellable from
    // here, and is the one thing this retrofit does not close.
    if (cancelledRef.current) return;
    if (result && result.bpm !== null) {
      setDocEntry(result);
      setRegionOverride(null);
      setSourceDraft(String(result.bpm));
    } else {
      setCorrectionFailed(true);
    }
  }

  function handleModeChange(next: Mode) {
    if (next === mode) return;
    if (next === 'percent' && validSource && validTarget) {
      setPercentDraft(String(round2((sourceNum / targetNum) * 100)));
    } else if (next === 'bpm' && Number.isFinite(targetNum) && targetNum > 0) {
      setTargetBpmDraft(String(round2(targetNum)));
    }
    setMode(next);
  }

  async function handleApply() {
    if (!canApply) return;
    setBusy(true);
    setProgress(0);
    setApplyError(null);
    try {
      const firstBeatSample = docEntry ? firstBeatAtOrAfter(docEntry.beatSamples, regionStart) : null;
      const outcome = await applyTempoChange(
        {
          sourceBpm: sourceNum,
          targetBpm: targetNum,
          addBeatMarkers,
          firstBeatSample,
          // Absent unless the user explicitly chose it AND confirmed the grid;
          // absent is today's behaviour, byte for byte.
          ...(correction === 'follow-beats' && gridConfirmed && confirmableGrid !== null
            ? { variableRate: { beatSamples: confirmableGrid } }
            : {}),
          // T6-3: read by the effect runner between the stretched audio arriving
          // and `applyEdit` writing it. True here means the tool is gone, so the
          // whole pass — audio, marker correction and beat grid — is dropped.
          shouldCancel: () => cancelledRef.current,
        },
        // Progress into a component that may have unmounted is a no-op React
        // warns about; the guard keeps the console honest as well as the state.
        (f) => {
          if (!cancelledRef.current) setProgress(f);
        }
      );
      // Nothing below may run after a cancel: `onClose()` would ask a host that
      // has already dropped this tool to drop it again, and the error line would
      // be set on a component nobody can read.
      if (cancelledRef.current) return;
      if (outcome.ok) {
        onClose();
      } else {
        setApplyError(refusalMessage(outcome.reason));
      }
    } finally {
      if (!cancelledRef.current) setBusy(false);
    }
  }

  let qualityText: string | null = null;
  let qualityClass = 'text-[#8b8b92]';
  if (check && !check.ok) {
    if (check.reason === 'no-op') {
      // v1.9.1 item 2: same tempo is not a dead end when markers are requested.
      qualityText = noOpWithMarkers
        ? 'Same tempo — beat markers will be laid at the current grid (no stretch).'
        : 'Target equals source tempo.';
      qualityClass = noOpWithMarkers ? 'text-[#26c6da]' : 'text-[#8b8b92]';
    } else if (check.reason === 'out-of-range') {
      const targetMin = Math.round(sourceNum / MAX_RATIO);
      const targetMax = Math.round(sourceNum / MIN_RATIO);
      qualityText = `Out of range: ${MIN_RATIO}x–${MAX_RATIO}x only (source ${sourceNum} BPM ⇒ target ${targetMin}–${targetMax} BPM)`;
      qualityClass = 'text-[#ef5350]';
    }
  } else if (ratio !== null) {
    const band = tempoQualityBand(ratio);
    if (band === 'transparent') {
      qualityText = 'Transparent';
      qualityClass = 'text-[#26c6da]';
    } else if (band === 'good') {
      qualityText = 'Good — slight transient smearing';
      qualityClass = 'text-[#8b8b92]';
    } else {
      qualityText = 'Extreme — expect flanging on sustained tones';
      qualityClass = 'text-[#e0a458]';
    }
  }

  // R7. The variable path has a RANGE of local ratios, so it is labelled by its
  // WORST segment, never by an average: an average that reads 'transparent'
  // while one bar is stretched 3x is precisely the reassurance this dialog must
  // not give. `BAND_RANK` orders the three bands so "worst" is a lookup rather
  // than a chain of comparisons that could disagree with `tempoQualityBand`.
  const BAND_RANK = { transparent: 0, good: 1, extreme: 2 } as const;
  const BAND_TEXT = {
    transparent: 'Transparent everywhere',
    good: 'Worst segment: good — slight transient smearing',
    extreme: 'Worst segment: extreme — expect flanging on sustained tones',
  } as const;
  const BAND_CLASS = {
    transparent: 'text-[#26c6da]',
    good: 'text-[#8b8b92]',
    extreme: 'text-[#e0a458]',
  } as const;
  const worstBand = variablePlan
    ? BAND_RANK[tempoQualityBand(variablePlan.map.minLocalRatio)] >=
      BAND_RANK[tempoQualityBand(variablePlan.map.maxLocalRatio)]
      ? tempoQualityBand(variablePlan.map.minLocalRatio)
      : tempoQualityBand(variablePlan.map.maxLocalRatio)
    : 'transparent';
  const worstBandText = BAND_TEXT[worstBand];
  const worstBandClass = BAND_CLASS[worstBand];

  return (
    <DialogShell
      title="Match Tempo"
      subtitle={doc.name}
      icon={<Gauge size={15} />}
      width={440}
      onClose={onClose}
      dismissable={!busy}
    >
      <div className="flex flex-col gap-3" data-testid="tempo-dialog">
        <SectionLabel>Estimate</SectionLabel>

        <div>
          <div data-testid="tempo-scope" className="text-xs" style={{ color: 'var(--glass-text-muted)' }}>
            {scopeText}
          </div>
          {selection && (
            <div data-testid="tempo-selection-note" className="mt-1 text-xs text-[#e0a458]">
              Only the selection is stretched; the rest of the file keeps its original tempo.
            </div>
          )}
        </div>

        <div>
          <div className="flex items-baseline justify-between gap-2">
            <span
              data-testid="tempo-detected"
              className="font-mono text-sm"
              style={{ color: 'var(--glass-text-title)' }}
            >
              {display?.bpm != null
                ? `${display.bpm.toFixed(1)} BPM${display.stale ? ' (stale)' : ''}`
                : 'Could not detect a tempo'}
            </span>
            {display?.bpm != null && (
              <span
                data-testid="tempo-confidence"
                className={display.confidence >= CONFIDENCE_LOW ? 'text-[#26c6da]' : 'text-[#e0a458]'}
              >
                {display.confidence >= CONFIDENCE_LOW ? 'confident' : 'low confidence — check this'}
              </span>
            )}
          </div>

          {display?.bpm == null && (
            <p className="mt-1 text-xs" style={{ color: 'var(--glass-text-muted)' }}>
              Type the tempo if you know it, or select a steady 8–16 bar passage and press Re-detect.
            </p>
          )}

          {docEntry === null && (
            <GlassButton
              data-testid="tempo-detect-button"
              onClick={() => void handleDetect()}
              disabled={detecting}
              className="mt-1"
              style={CHIP}
            >
              Detect
            </GlassButton>
          )}

          <div className="mt-1 flex flex-wrap items-center gap-1">
            {display?.bpm != null && docEntry?.bpm != null && (
              <>
                <GlassButton
                  data-testid="tempo-double-button"
                  title="Double tempo (x2) — re-tracks the beat grid"
                  onClick={() => void correctOctave(2)}
                  style={CHIP}
                >
                  x2
                </GlassButton>
                <GlassButton
                  data-testid="tempo-halve-button"
                  title="Halve tempo (/2) — re-tracks the beat grid"
                  onClick={() => void correctOctave(0.5)}
                  style={CHIP}
                >
                  /2
                </GlassButton>
              </>
            )}
            <GlassButton
              data-testid="tempo-redetect-button"
              onClick={handleRedetectFromSelection}
              style={CHIP}
            >
              Re-detect from selection
            </GlassButton>
          </div>

          {correctionFailed && (
            <p data-testid="tempo-correction-failed" className="mt-1 text-xs text-[#e0a458]">
              Correction failed — grid unchanged.
            </p>
          )}
          {selectionChanged && (
            <p data-testid="tempo-selection-changed" className="mt-1 text-xs text-[#e0a458]">
              Selection changed — re-detect
            </p>
          )}
        </div>

        <SectionLabel>Target</SectionLabel>

        <div>
          <FieldLabel htmlFor="tempo-source">Source BPM</FieldLabel>
          <GlassField
            id="tempo-source"
            ref={sourceInputRef}
            type="number"
            data-testid="tempo-source"
            min={20}
            max={400}
            value={sourceDraft}
            onChange={(e) => setSourceDraft(e.target.value)}
          />
        </div>

        <div>
          <FieldLabel htmlFor="tempo-mode">Mode</FieldLabel>
          <GlassSelect
            id="tempo-mode"
            data-testid="tempo-mode"
            value={mode}
            onChange={(e) => handleModeChange(e.target.value as Mode)}
          >
            <option value="bpm">Target BPM</option>
            <option value="percent">Ratio (%)</option>
          </GlassSelect>
        </div>

        {mode === 'bpm' ? (
          <div>
            <FieldLabel htmlFor="tempo-target">Target BPM</FieldLabel>
            <GlassField
              id="tempo-target"
              type="number"
              data-testid="tempo-target"
              min={20}
              max={400}
              value={targetBpmDraft}
              onChange={(e) => setTargetBpmDraft(e.target.value)}
            />
          </div>
        ) : (
          <div>
            <FieldLabel htmlFor="tempo-percent">Ratio (%)</FieldLabel>
            <GlassField
              id="tempo-percent"
              type="number"
              data-testid="tempo-percent"
              value={percentDraft}
              onChange={(e) => setPercentDraft(e.target.value)}
            />
          </div>
        )}

        {ratio !== null && correction === 'one-ratio' && (
          <div data-testid="tempo-summary" className="text-xs" style={{ color: 'var(--glass-text-label)' }}>
            {`x${ratio.toFixed(4)} · ${regionSeconds.toFixed(2)} s → ${(regionSeconds * ratio).toFixed(2)} s · pitch unchanged`}
          </div>
        )}

        {qualityText && correction === 'one-ratio' && (
          <div data-testid="tempo-quality" className={`text-xs ${qualityClass}`}>
            {qualityText}
          </div>
        )}

        <SectionLabel>Correction</SectionLabel>

        <div>
          <FieldLabel htmlFor="tempo-correction">Across the region</FieldLabel>
          <GlassSelect
            id="tempo-correction"
            data-testid="tempo-correction"
            value={correction}
            disabled={!canFollowBeats}
            onChange={(e) => setCorrection(e.target.value as Correction)}
          >
            <option value="one-ratio">One ratio (steady material)</option>
            <option value="follow-beats">Follow the tracked beats (varying tempo)</option>
          </GlassSelect>
          {!canFollowBeats && (
            <p data-testid="tempo-follow-unavailable" className="mt-1 text-xs" style={{ color: 'var(--glass-text-muted)' }}>
              Following the beats needs a fresh beat grid with at least two beats in this
              region — press Detect, then check the grid.
            </p>
          )}
        </div>

        {correction === 'follow-beats' && canFollowBeats && (
          <div className="flex flex-col gap-2">
            <p className="text-xs" style={{ color: 'var(--glass-text-muted)' }}>
              Each tracked beat is moved onto the target grid instead of the whole region
              sharing one ratio. A wrong grid is corrected differently in every bar, so
              check the tics on the waveform — and the x2 / /2 buttons above — before
              applying.
            </p>

            <label className="flex items-center gap-2 text-xs" style={{ color: 'var(--glass-text-label)' }}>
              <input
                type="checkbox"
                data-testid="tempo-grid-confirmed"
                checked={gridConfirmed}
                onChange={(e) => setGridConfirmed(e.target.checked)}
                className="accent-[#26c6da]"
              />
              The beat grid is correct
            </label>

            {variablePlan !== null ? (
              <>
                <div
                  data-testid="tempo-variable-summary"
                  className="text-xs"
                  style={{ color: 'var(--glass-text-label)' }}
                >
                  {`${variablePlan.beatCount} beats · x${variablePlan.map.minLocalRatio.toFixed(4)}–x${variablePlan.map.maxLocalRatio.toFixed(4)} · ${regionSeconds.toFixed(2)} s → ${(variablePlan.outLength / doc.sampleRate).toFixed(2)} s · pitch unchanged`}
                </div>
                {/* The WORST segment's band, not the average's: an average that
                    reads 'transparent' while one bar is stretched 3x is exactly
                    the reassurance this dialog must not give. */}
                <div data-testid="tempo-variable-quality" className={`text-xs ${worstBandClass}`}>
                  {worstBandText}
                </div>
                {variablePlan.clampedCount > 0 && (
                  <div data-testid="tempo-variable-clamped" className="text-xs text-[#e0a458]">
                    {/* GAPS, not beats: `clampedIndices` counts the intervals
                        BETWEEN beats, so its ceiling is beatCount - 1. Reading
                        "N of M beats" against M beats made the worst case look
                        like a fraction of the whole when it was already all of
                        it. */}
                    {`${variablePlan.clampedCount} of ${Math.max(0, variablePlan.beatCount - 1)} gaps between beats could not reach the target — they were stretched as far as the ${MIN_RATIO}x–${MAX_RATIO}x limit allows.`}
                  </div>
                )}
              </>
            ) : (
              <div data-testid="tempo-variable-refusal" className="text-xs text-[#8b8b92]">
                {variableCheck === null
                  ? 'Enter a target tempo.'
                  : refusalMessage(variableCheck.ok ? undefined : variableCheck.reason)}
              </div>
            )}
          </div>
        )}

        <SectionLabel>Options</SectionLabel>

        <label className="flex items-center gap-2 text-xs" style={{ color: 'var(--glass-text-label)' }}>
          <input
            type="checkbox"
            data-testid="tempo-beat-markers"
            checked={addBeatMarkers}
            disabled={!hasBeatPhase}
            onChange={(e) => setAddBeatMarkers(e.target.checked)}
            className="accent-[#26c6da]"
          />
          {`Add beat markers at the new tempo (max ${MAX_BEAT_MARKERS})`}
        </label>

        <p className="text-xs" style={{ color: 'var(--glass-text-muted)' }}>
          Applied off the main thread — this can take a while on long files.
        </p>

        {applyError && (
          <p data-testid="tempo-apply-error" className="text-xs text-[#ef5350]">
            {applyError}
          </p>
        )}

        {busy && (
          <div
            className="h-1.5 w-full overflow-hidden rounded-full"
            style={{
              background: 'rgba(255, 255, 255, 0.09)',
              boxShadow: 'inset 0 1px 2px rgba(0, 0, 0, 0.6)',
            }}
          >
            <div
              data-testid="tempo-progress"
              className="h-full transition-[width]"
              style={{
                width: `${Math.round(progress * 100)}%`,
                background: 'var(--accent)',
                boxShadow: '0 0 8px var(--accent-ring)',
              }}
            />
          </div>
        )}

        <div className="mt-2 flex justify-end gap-2">
          {/* U2-3: disabled while the change is applying, matching the seven
              other pipeline tools whose in-card cancel already was. `dismissable`
              stops Escape, the backdrop and the module column's ✕ mid-pass, but
              it cannot govern a button inside this body — so without this, the
              one control still live was the one that discarded the run. */}
          <GlassButton data-testid="tempo-cancel" onClick={onClose} disabled={busy}>
            Cancel
          </GlassButton>
          <GlassButton variant="primary" onClick={() => void handleApply()} disabled={!canApply}>
            Apply
          </GlassButton>
        </div>
      </div>
    </DialogShell>
  );
}
