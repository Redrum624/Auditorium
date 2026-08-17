import { useEffect, useMemo, useRef, useState } from 'react';
import { AlignHorizontalDistributeCenter, Wand2 } from 'lucide-react';
import { CONFIDENCE_LOW } from '../../dsp/tempoCore';
import { DEFAULT_STRENGTH, MAX_LOCAL_RATIO, MIN_LOCAL_RATIO } from '../../dsp/timingWarp';
import { useAppStore } from '../../stores/appStore';
import { getBeatGrid, useBeatGridVersion, type BeatGrid } from '../../services/beatGrid';
import { getTempo, regridTempo } from '../../services/tempoAnalysis';
import {
  applyTimingAlignment,
  buildAlignPlan,
  suggestSyllableMarkers,
  MAX_SUGGEST_SECONDS,
  type AlignPlan,
  type AlignRefusal,
} from '../../services/timingAlignService';
import { FieldLabel, GlassButton, GlassSelect, GlassSlider, SectionLabel } from '../UI/glass';
import DialogShell from './DialogShell';

const CHIP = { padding: '2px 8px', fontSize: 11 } as const;

/** Subdivisions offered. Labelled by what they ARE musically; the median move
 * each one implies is appended live, because that number — not the label — is
 * what tells the user which one the performance is actually on. */
const DIVISIONS: { value: number; label: string }[] = [
  { value: 1, label: 'Beat' },
  { value: 2, label: '½ beat' },
  { value: 4, label: '¼ beat' },
];

function refusalMessage(reason: AlignRefusal): string {
  switch (reason) {
    case 'no-document':
      return 'No document is open.';
    case 'no-grid':
      return 'No beat grid for this file yet — run Pipeline → Detect Tempo first.';
    case 'no-anchors':
      return 'No markers inside the region. Place a marker on each syllable you want moved, or use Suggest syllable markers.';
    case 'region-too-short':
      return 'The selected region is too short to align.';
    case 'no-change':
      return 'Nothing to move at this strength.';
    case 'cancelled':
      // T6-3. Unreachable from THIS dialog by construction — a cancelled pass is
      // one whose tool is already gone, so `handleApply` returns before it can
      // set an error line — and written anyway because the reason is part of the
      // service's contract and `testHooks` reads the same outcome. Without its
      // own arm it would fall to the default and report the user's own cancel as
      // a failure to apply.
      return 'The alignment was cancelled. Nothing was changed.';
    default:
      return 'The alignment did not apply.';
  }
}

/** BPM implied by the tracked beats. Derived here rather than read from the
 * analysis because {@link BeatGrid} deliberately carries positions, not a tempo
 * — and an inherited or detached grid has no entry to read a BPM from. The
 * MEDIAN inter-beat gap, not the mean, so one dropped beat cannot skew it. */
function gridBpm(grid: BeatGrid): number | null {
  const b = grid.beatSamples;
  if (b.length < 2) return null;
  const gaps: number[] = [];
  for (let i = 1; i < b.length; i++) gaps.push(b[i] - b[i - 1]);
  gaps.sort((x, y) => x - y);
  const med = gaps[Math.floor(gaps.length / 2)];
  return med > 0 ? (60 * grid.sampleRate) / med : null;
}

const ms = (samples: number, rate: number): string => `${Math.round((samples / rate) * 1000)} ms`;

/**
 * F9 — Align Vocal Timing.
 *
 * The dialog exists because the DSP must not decide two things it cannot know:
 *
 * **Which grid.** On the user's own material the drums track at 159.83 BPM and
 * five other sources at ~109.4 — a real ~3:2 feel, with every confidence
 * between 0.003 and 0.084 against `CONFIDENCE_LOW = 0.35`. Both grids are
 * musically defensible, so an automatic pick is a coin flip that makes every
 * correction 2/3 or 1.5x wrong. Apply stays disabled until "Grid and
 * subdivision are correct" is ticked — the same affordance RemixDialog already
 * uses for the same reason — and the ×2 / ÷2 buttons re-track through
 * `regridTempo` (never a local relabel: at the wrong octave `beatSamples`
 * physically contains only every other beat).
 *
 * **Which syllables.** Onset detection on a real legato vocal was measured at
 * 0.88 precision at best (0.56 at the parameters tempo detection ships with) —
 * see `timingWarp.ts`. So the anchors are MARKERS, which the user placed or
 * kept. "Suggest syllable markers" writes the detector's proposals in as
 * ordinary markers, as their own undo step, so they can be dragged and deleted
 * with the tools already in the app before any audio is touched.
 *
 * Everything the run will do is on screen first: how many syllables move, the
 * median and largest move, and how many the ratio bound will hold back.
 */
export default function AlignTimingDialog({ onClose }: { onClose: () => void }) {
  const doc = useAppStore((s) => s.documents.find((d) => d.id === s.activeDocumentId) ?? null);
  const selection = useAppStore((s) => s.selection);
  const markers = useAppStore((s) => (doc ? s.markers[doc.id] : undefined));
  const gridVersion = useBeatGridVersion();

  const [division, setDivision] = useState(1);
  const [strengthPct, setStrengthPct] = useState(Math.round(DEFAULT_STRENGTH * 100));
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  /**
   * T6-3 — the unmount guard this dialog had NONE of.
   *
   * U2's fix round found the claim that "all nine discard on unmount" false and
   * named this one the worse of the two exceptions: `TempoDialog` at least
   * guarded a DOM ref, this had nothing, so both of its committing paths landed
   * in a document the user had walked away from. The module lock has been
   * holding the app still to prevent that.
   *
   * Two things need the guard, and they are not the same kind:
   *
   * - **Apply** is asynchronous work whose commit is inside the effect runner,
   *   so the flag is handed DOWN and read there, between the warped audio and
   *   `applyEdit`.
   * - **Suggest** is synchronous work deferred by one frame. Its commit is in
   *   this file, so the frame is cancelled on unmount and the flag re-checked
   *   inside the callback — a `requestAnimationFrame` scheduled by a component
   *   that is gone still fires, and this one writes markers and an undo entry.
   */
  const cancelledRef = useRef(false);
  const suggestFrameRef = useRef<number | null>(null);
  useEffect(() => {
    cancelledRef.current = false;
    return () => {
      cancelledRef.current = true;
      if (suggestFrameRef.current !== null) cancelAnimationFrame(suggestFrameRef.current);
    };
  }, []);

  // `getBeatGrid` is a cached read that never starts an analysis, so opening
  // this dialog cannot kick off a worker (beatGrid.ts guarantee 1).
  const grid = useMemo(
    () => (doc ? getBeatGrid(doc.id) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- gridVersion is the change token
    [doc?.id, gridVersion]
  );

  const strength = strengthPct / 100;

  const planResult = useMemo(
    () => buildAlignPlan({ division, strength }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- markers/selection/gridVersion are the inputs buildAlignPlan reads from the store
    [division, strength, markers, selection, gridVersion, doc?.id]
  );
  const plan: AlignPlan | null = planResult.ok ? planResult.plan : null;

  /** Median move each subdivision would imply, so the choice is made from the
   * measurement rather than from the label. Recomputed per render; the plan
   * builder is pure arithmetic over the marker list. */
  const divisionMedians = useMemo(
    () =>
      DIVISIONS.map((d) => {
        const r = buildAlignPlan({ division: d.value, strength });
        return r.ok ? r.plan.medianOffsetSamples : null;
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- same store inputs as above
    [strength, markers, selection, gridVersion, doc?.id]
  );

  if (!doc) return null;

  const rate = doc.sampleRate;
  const bpm = grid ? gridBpm(grid) : null;
  const lowConfidence = grid !== null && grid.confidence < CONFIDENCE_LOW;
  const canRegrid = grid !== null && grid.origin === 'own' && getTempo(doc) !== null;
  const canApply = !busy && plan !== null && confirmed && strengthPct > 0;

  async function correctOctave(periodMultiplier: 2 | 0.5) {
    if (!doc || !canRegrid) return;
    const entry = getTempo(doc);
    if (!entry || entry.bpm === null) return;
    setError(null);
    setConfirmed(false);
    const result = await regridTempo(doc.id, entry.periodFrames / periodMultiplier);
    // A re-track writes the analysis CACHE for the document it re-tracked — not
    // the document, not an undo entry — so the run is left alone and only the
    // setState is guarded. See the T6 report's recorded concern.
    if (cancelledRef.current) return;
    if (!result || result.bpm === null) setError('Could not re-track at that tempo.');
  }

  function handleSuggest() {
    setError(null);
    setBusy(true);
    // Detection is synchronous (≈350 ms per 30 s at 48 kHz). Yield one frame
    // first so the busy state actually paints before the thread blocks.
    suggestFrameRef.current = requestAnimationFrame(() => {
      suggestFrameRef.current = null;
      // T6-3: belt and braces with the cleanup's `cancelAnimationFrame`. The
      // cancel is what normally stops this, but a frame already dispatched when
      // the unmount lands still runs, and this call WRITES markers plus an undo
      // entry — so the decision is re-read here rather than assumed.
      if (cancelledRef.current) return;
      try {
        const outcome = suggestSyllableMarkers();
        if (!outcome) {
          setError('Nothing to analyse in this region.');
        } else if (outcome.added === 0) {
          setNote('No syllable onsets found in this region.');
        } else {
          const truncNote = outcome.truncated ? ' (list capped)' : '';
          setNote(
            `Added ${outcome.added} marker${outcome.added === 1 ? '' : 's'} over ${outcome.analysedSeconds.toFixed(0)} s${truncNote}. Roughly one in eight is not a syllable — check and delete before applying.`
          );
        }
      } finally {
        setBusy(false);
      }
    });
  }

  async function handleApply() {
    if (!canApply || !plan) return;
    setBusy(true);
    setProgress(0);
    setError(null);
    try {
      const outcome = await applyTimingAlignment(
        // T6-3: read by the effect runner between the warped audio arriving and
        // `applyEdit` writing it, and again before the marker remap — so a
        // walk-away leaves neither the audio nor the markers moved.
        { plan, strength, shouldCancel: () => cancelledRef.current },
        (f) => {
          if (!cancelledRef.current) setProgress(f);
        }
      );
      // `onClose()` on a tool the host has already dropped, and an error line on
      // a component nobody can read, are both writes to a dialog that is gone.
      if (cancelledRef.current) return;
      if (outcome.ok) onClose();
      else setError(refusalMessage(outcome.reason));
    } finally {
      if (!cancelledRef.current) setBusy(false);
    }
  }

  const scopeText = selection
    ? `Selection — ${ms(selection.end - selection.start, rate)}`
    : 'Whole file';

  return (
    <DialogShell
      title="Align Vocal Timing"
      subtitle={doc.name}
      icon={<AlignHorizontalDistributeCenter size={15} />}
      width={460}
      onClose={onClose}
      dismissable={!busy}
    >
      <div className="flex flex-col gap-3" data-testid="align-timing-dialog">
        <div data-testid="align-scope" className="text-xs" style={{ color: 'var(--glass-text-muted)' }}>
          {scopeText}
        </div>

        <SectionLabel>Grid</SectionLabel>

        {!grid ? (
          <p data-testid="align-no-grid" className="text-xs text-[#e0a458]">
            {refusalMessage('no-grid')}
          </p>
        ) : (
          <>
            <div className="flex items-baseline justify-between gap-2">
              <span
                data-testid="align-grid-summary"
                className="font-mono text-sm"
                style={{ color: 'var(--glass-text-title)' }}
              >
                {bpm !== null ? `${bpm.toFixed(1)} BPM` : 'no tempo'} · {grid.beatSamples.length} beats
                {grid.origin === 'inherited' ? ' · inherited' : ''}
                {grid.stale ? ' · stale' : ''}
              </span>
              <div className="flex gap-1">
                <GlassButton
                  data-testid="align-octave-double"
                  style={CHIP}
                  disabled={!canRegrid || busy}
                  onClick={() => void correctOctave(2)}
                >
                  ×2
                </GlassButton>
                <GlassButton
                  data-testid="align-octave-half"
                  style={CHIP}
                  disabled={!canRegrid || busy}
                  onClick={() => void correctOctave(0.5)}
                >
                  ÷2
                </GlassButton>
              </div>
            </div>

            <p
              data-testid="align-confidence"
              className={`text-xs ${lowConfidence ? 'text-[#e0a458]' : ''}`}
              style={lowConfidence ? undefined : { color: 'var(--glass-text-muted)' }}
            >
              {lowConfidence
                ? `Confidence ${grid.confidence.toFixed(2)} — below the ${CONFIDENCE_LOW} the app trusts. A wrong grid moves every syllable the wrong way; check the moves below before applying.`
                : `Confidence ${grid.confidence.toFixed(2)}.`}
            </p>

            <div>
              <FieldLabel htmlFor="align-division">Snap syllables to</FieldLabel>
              <GlassSelect
                id="align-division"
                data-testid="align-division"
                value={String(division)}
                disabled={busy}
                onChange={(e) => {
                  setDivision(Number(e.target.value));
                  setConfirmed(false);
                }}
              >
                {DIVISIONS.map((d, i) => (
                  <option key={d.value} value={d.value}>
                    {d.label}
                    {divisionMedians[i] !== null ? ` — median move ${ms(divisionMedians[i]!, rate)}` : ''}
                  </option>
                ))}
              </GlassSelect>
            </div>

            <label className="flex items-center gap-2 text-xs" style={{ color: 'var(--glass-text-label)' }}>
              <input
                type="checkbox"
                data-testid="align-grid-confirmed"
                checked={confirmed}
                disabled={busy}
                onChange={(e) => setConfirmed(e.target.checked)}
                className="accent-[#26c6da]"
              />
              Grid and subdivision are correct
            </label>
          </>
        )}

        <SectionLabel>Syllables</SectionLabel>

        <div>
          <p data-testid="align-anchor-summary" className="text-xs" style={{ color: 'var(--glass-text-muted)' }}>
            {plan
              ? `${plan.anchors.length} marker${plan.anchors.length === 1 ? '' : 's'} will move — median ${ms(plan.medianOffsetSamples, rate)}, largest ${ms(plan.maxOffsetSamples, rate)}.`
              : refusalMessage(planResult.ok ? 'no-anchors' : planResult.reason)}
          </p>
          {plan && plan.droppedCount > 0 && (
            <p data-testid="align-dropped" className="mt-1 text-xs" style={{ color: 'var(--glass-text-muted)' }}>
              {plan.droppedCount} marker{plan.droppedCount === 1 ? '' : 's'} skipped (on a region edge, or sharing a
              position with another).
            </p>
          )}
        </div>

        <div className="flex items-center gap-2">
          <GlassButton data-testid="align-suggest" disabled={busy} onClick={handleSuggest}>
            <Wand2 size={13} />
            Suggest syllable markers
          </GlassButton>
        </div>
        <p className="text-xs" style={{ color: 'var(--glass-text-muted)' }}>
          Detection is a proposal, not a decision: measured on a real solo vocal it gets roughly one anchor in eight
          wrong, and finds about two thirds of the syllables. It writes ordinary markers (first {MAX_SUGGEST_SECONDS} s
          of the region) so you can delete the wrong ones first.
        </p>
        {note && (
          <p data-testid="align-note" className="text-xs" style={{ color: 'var(--glass-text-label)' }}>
            {note}
          </p>
        )}

        <SectionLabel>Correction</SectionLabel>

        <div>
          <FieldLabel htmlFor="align-strength">Strength</FieldLabel>
          <div className="flex items-center gap-3">
            <GlassSlider
              className="flex-1"
              id="align-strength"
              data-testid="align-strength"
              min={0}
              max={100}
              step={1}
              value={strengthPct}
              disabled={busy}
              edited={strengthPct !== Math.round(DEFAULT_STRENGTH * 100)}
              onChange={(e) => setStrengthPct(Number(e.target.value))}
            />
            <span
              data-testid="align-strength-readout"
              className="w-24 shrink-0 text-right font-mono text-xs"
              style={{ color: 'var(--glass-text-label)' }}
            >
              {strengthPct}%
            </span>
          </div>
          {plan && (
            <p data-testid="align-residual" className="mt-1 text-xs" style={{ color: 'var(--glass-text-muted)' }}>
              Leaves {ms(plan.medianOffsetSamples * (1 - strength), rate)} of the median move in place — a fully
              quantised vocal sounds machine-made, so the default corrects a quarter of the error.
            </p>
          )}
        </div>

        {plan && plan.clampedIndices.length > 0 && (
          <p data-testid="align-clamped" className="text-xs text-[#e0a458]">
            {plan.clampedIndices.length} of {plan.anchors.length} moves are limited by the {MIN_LOCAL_RATIO}–
            {MAX_LOCAL_RATIO}× stretch bound and will land short of the grid. Lower the strength, or add markers so each
            move is spread over a longer span.
          </p>
        )}

        {error && (
          <p data-testid="align-error" className="text-xs text-[#ef5350]">
            {error}
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
              data-testid="align-progress"
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
          <GlassButton onClick={onClose} disabled={busy}>
            Cancel
          </GlassButton>
          <GlassButton
            variant="primary"
            data-testid="align-apply"
            onClick={() => void handleApply()}
            disabled={!canApply}
          >
            Apply
          </GlassButton>
        </div>
      </div>
    </DialogShell>
  );
}
