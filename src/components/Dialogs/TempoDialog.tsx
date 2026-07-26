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
  detectRegionTempo,
  tempoQualityBand,
  tempoRatio,
  MAX_BEAT_MARKERS,
  type RegionTempoDetection,
  type TempoRefusal,
} from '../../services/tempoService';
import { CONFIDENCE_LOW } from '../../dsp/tempoCore';
import { MIN_RATIO, MAX_RATIO } from '../../dsp/wsola';
import DialogShell from './DialogShell';

const FIELD =
  'w-full rounded border border-[#3a3a42] bg-[#2e2e34] px-2 py-1 text-sm text-[#d4d4d8] focus:border-[#26c6da] focus:outline-none';
const LABEL = 'mb-1 block text-xs text-[#8b8b92]';

type Mode = 'bpm' | 'percent';

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
    case 'no-document':
      return 'No document is open.';
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

  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [applyError, setApplyError] = useState<string | null>(null);

  const sourceInputRef = useRef<HTMLInputElement>(null);

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

  const regionStart = selection ? selection.start : 0;
  const regionEnd = selection ? selection.end : docLength(doc);
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

  const canApply = validSource && validTarget && check !== null && check.ok && !busy;

  async function handleDetect() {
    if (!doc || detecting) return;
    setDetecting(true);
    try {
      const result = await runTempoAnalysis(doc);
      setDocEntry(result);
      setRegionOverride(null);
      setCorrectionFailed(false);
      setLastEstimateSelection(useAppStore.getState().selection);
      if (result?.bpm != null) setSourceDraft(String(result.bpm));
    } finally {
      setDetecting(false);
    }
  }

  function handleRedetectFromSelection() {
    const result = detectRegionTempo();
    setRegionOverride(result);
    setCorrectionFailed(false);
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
    const newPeriodFrames = docEntry.periodFrames / periodMultiplier;
    const result = await regridTempo(doc.id, newPeriodFrames);
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
        { sourceBpm: sourceNum, targetBpm: targetNum, addBeatMarkers, firstBeatSample },
        setProgress
      );
      if (outcome.ok) {
        onClose();
      } else {
        setApplyError(refusalMessage(outcome.reason));
      }
    } finally {
      setBusy(false);
    }
  }

  let qualityText: string | null = null;
  let qualityClass = 'text-[#8b8b92]';
  if (check && !check.ok) {
    if (check.reason === 'no-op') {
      qualityText = 'Target equals source tempo.';
      qualityClass = 'text-[#8b8b92]';
    } else if (check.reason === 'out-of-range') {
      const targetMin = Math.round(sourceNum / MAX_RATIO);
      const targetMax = Math.round(sourceNum / MIN_RATIO);
      qualityText = `Out of range: 0.25x–4x only (source ${sourceNum} BPM ⇒ target ${targetMin}–${targetMax} BPM)`;
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

  return (
    <DialogShell title="Match Tempo" onClose={onClose} dismissable={!busy}>
      <div className="flex flex-col gap-3" data-testid="tempo-dialog">
        <div>
          <div data-testid="tempo-scope" className="text-xs text-[#8b8b92]">
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
            <span data-testid="tempo-detected" className="text-sm text-[#d4d4d8]">
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
            <p className="mt-1 text-xs text-[#8b8b92]">
              Type the tempo if you know it, or select a steady 8–16 bar passage and press Re-detect.
            </p>
          )}

          {docEntry === null && (
            <button
              type="button"
              data-testid="tempo-detect-button"
              onClick={() => void handleDetect()}
              disabled={detecting}
              className="mt-1 rounded border border-[#3a3a42] bg-[#2e2e34] px-2 py-0.5 text-xs text-[#d4d4d8] hover:bg-[#3a3a42] disabled:opacity-50"
            >
              Detect
            </button>
          )}

          <div className="mt-1 flex flex-wrap items-center gap-1">
            {display?.bpm != null && docEntry?.bpm != null && (
              <>
                <button
                  type="button"
                  data-testid="tempo-double-button"
                  title="Double tempo (x2) — re-tracks the beat grid"
                  onClick={() => void correctOctave(2)}
                  className="rounded border border-[#3a3a42] px-1 text-xs text-[#d4d4d8] hover:border-[#26c6da]"
                >
                  x2
                </button>
                <button
                  type="button"
                  data-testid="tempo-halve-button"
                  title="Halve tempo (/2) — re-tracks the beat grid"
                  onClick={() => void correctOctave(0.5)}
                  className="rounded border border-[#3a3a42] px-1 text-xs text-[#d4d4d8] hover:border-[#26c6da]"
                >
                  /2
                </button>
              </>
            )}
            <button
              type="button"
              data-testid="tempo-redetect-button"
              onClick={handleRedetectFromSelection}
              className="rounded border border-[#3a3a42] px-1 text-xs text-[#d4d4d8] hover:border-[#26c6da]"
            >
              Re-detect from selection
            </button>
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

        <div>
          <label className={LABEL} htmlFor="tempo-source">
            Source BPM
          </label>
          <input
            id="tempo-source"
            ref={sourceInputRef}
            type="number"
            data-testid="tempo-source"
            min={20}
            max={400}
            value={sourceDraft}
            onChange={(e) => setSourceDraft(e.target.value)}
            className={FIELD}
          />
        </div>

        <div>
          <label className={LABEL} htmlFor="tempo-mode">
            Mode
          </label>
          <select
            id="tempo-mode"
            data-testid="tempo-mode"
            className={FIELD}
            value={mode}
            onChange={(e) => handleModeChange(e.target.value as Mode)}
          >
            <option value="bpm">Target BPM</option>
            <option value="percent">Ratio (%)</option>
          </select>
        </div>

        {mode === 'bpm' ? (
          <div>
            <label className={LABEL} htmlFor="tempo-target">
              Target BPM
            </label>
            <input
              id="tempo-target"
              type="number"
              data-testid="tempo-target"
              min={20}
              max={400}
              value={targetBpmDraft}
              onChange={(e) => setTargetBpmDraft(e.target.value)}
              className={FIELD}
            />
          </div>
        ) : (
          <div>
            <label className={LABEL} htmlFor="tempo-percent">
              Ratio (%)
            </label>
            <input
              id="tempo-percent"
              type="number"
              data-testid="tempo-percent"
              value={percentDraft}
              onChange={(e) => setPercentDraft(e.target.value)}
              className={FIELD}
            />
          </div>
        )}

        {ratio !== null && (
          <div data-testid="tempo-summary" className="text-xs text-[#d4d4d8]">
            {`x${ratio.toFixed(4)} · ${regionSeconds.toFixed(2)} s → ${(regionSeconds * ratio).toFixed(2)} s · pitch unchanged`}
          </div>
        )}

        {qualityText && (
          <div data-testid="tempo-quality" className={`text-xs ${qualityClass}`}>
            {qualityText}
          </div>
        )}

        <label className="flex items-center gap-2 text-xs text-[#d4d4d8]">
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

        <p className="text-xs text-[#8b8b92]">
          Applied off the main thread — this can take a while on long files.
        </p>

        {applyError && (
          <p data-testid="tempo-apply-error" className="text-xs text-[#ef5350]">
            {applyError}
          </p>
        )}

        {busy && (
          <div className="h-1.5 w-full overflow-hidden rounded bg-[#2e2e34]">
            <div
              data-testid="tempo-progress"
              className="h-full bg-[#26c6da] transition-[width]"
              style={{ width: `${Math.round(progress * 100)}%` }}
            />
          </div>
        )}

        <div className="mt-2 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="rounded border border-[#3a3a42] bg-[#2e2e34] px-3 py-1 text-sm text-[#d4d4d8] hover:bg-[#3a3a42] disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void handleApply()}
            disabled={!canApply}
            className="rounded bg-[#26c6da] px-3 py-1 text-sm font-medium text-[#101014] hover:brightness-110 disabled:opacity-50"
          >
            Apply
          </button>
        </div>
      </div>
    </DialogShell>
  );
}
