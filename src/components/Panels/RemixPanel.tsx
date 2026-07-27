import { useEffect, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, Pin, X } from 'lucide-react';
import { useAppStore } from '../../stores/appStore';
import { formatTime } from '../../utils/timeFormat';
import {
  MAX_LOCKED_JOINS,
  getRemixSession,
  nudgeJoin,
  reRollRemix,
  rejectJoin,
  resetRemix,
  toggleLockJoin,
  updateRemixSession,
  useRemixVersion,
  type ToggleLockRefusal,
} from '../../services/remixService';
import type { JoinCostTerms } from '../../dsp/remixCost';

/**
 * The Auto-Remix adjustment surface (Task T15) for the ACTIVE document's remix
 * session — one row per join, plus the header-level Re-roll / Revert to auto /
 * crossfade controls.
 *
 * Deliberately a THIN surface over `remixService`: reject / lock / nudge /
 * re-roll / reset all live there, enforce their own invariants there, and are
 * the reason this panel exists at all. Nothing here re-derives a rule the
 * service already owns (the pin cap is the service's `MAX_LOCKED_JOINS`, the
 * "nothing to re-roll" test is the plan's own `canReroll`).
 *
 * Three wiring facts that are NOT cosmetic:
 *
 * 1. `useRemixVersion()` is called FIRST. The session store is module state
 *    behind `useSyncExternalStore`, not zustand, so without this subscription
 *    an adjustment would mutate the session and re-render nothing. There is
 *    also no allocating zustand selector below (each one returns a stable
 *    reference), which is the `MarkersPanel.tsx:12` `NO_MARKERS` lesson in its
 *    other form — an allocating snapshot is an infinite render loop.
 *
 * 2. Go To carries the `if (view === 'multitrack') setView('waveform')` guard
 *    (`MarkersPanel.tsx:72-85`). Cursor and zoom are the waveform/spectral
 *    editor's state; jumping while multitrack is on screen would be a silent
 *    no-op.
 *
 * 3. Staleness is a HARD gate. When the source document was edited or closed
 *    every adjustment in the service is already a no-op returning `null`;
 *    rather than let the user press dead controls, the banner explains it and
 *    every control — including Go To, per the task's own acceptance — is
 *    disabled. The remix audio itself is untouched and still plays.
 *
 * The row anatomy mirrors `MarkersPanel`: a plain container with SIBLING
 * controls, never a clickable row (a real double-click fires click, click,
 * dblclick, so a row-level handler fires twice before anything else can).
 *
 * UI scope: this ships as bare function. The v1.5 plan states the surface is
 * disposable and the service behind it is not; the layout gets its pass once
 * the three features land.
 */

// Quality thresholds (plan T15): green < 0.6, amber < 1.2, red >= 1.2, against
// `JoinCostTerms.total` — the join's own six-term cost, NOT the planner's
// jump toll or its synthetic re-roll penalties.
const QUALITY_GOOD = 'bg-[#66bb6a]';
const QUALITY_FAIR = 'bg-[#ffa726]';
const QUALITY_POOR = 'bg-[#ef5350]';

function qualityClass(total: number): string {
  if (total < 0.6) return QUALITY_GOOD;
  if (total < 1.2) return QUALITY_FAIR;
  return QUALITY_POOR;
}

/** The six terms `joinCost` breaks its total into, in the plan's own order and
 * wording ('level' is `loudness`, 'structure' is `struct`). This breakdown is
 * the whole reason `joinCost` returns terms rather than a scalar: it lets a
 * user see WHY a join is flagged. */
const COST_TERMS: { label: string; key: keyof JoinCostTerms }[] = [
  { label: 'timbre', key: 'timbre' },
  { label: 'chroma', key: 'chroma' },
  { label: 'level', key: 'loudness' },
  { label: 'rhythm', key: 'rhythm' },
  { label: 'structure', key: 'struct' },
  { label: 'phrase', key: 'phrase' },
];

function costTooltip(cost: JoinCostTerms): string {
  const terms = COST_TERMS.map((t) => `${t.label} ${cost[t.key].toFixed(2)}`).join(' · ');
  return `Join cost ${cost.total.toFixed(2)} = ${terms}`;
}

/** `m:ss` — the panel's own clock. `formatTime` always carries milliseconds,
 * which is the right resolution for a marker position and the wrong one for an
 * arrangement summary. */
function clock(sample: number, sampleRate: number): string {
  return formatTime(sample, sampleRate).replace(/\.\d+$/, '');
}

/** A pin is a STRONG PREFERENCE, never a promise: `remixPlan.ts` has no
 * `requiredJoins` constraint — pinned keys are merely exempted from the
 * re-roll penalty and given a tie-break bonus, so a genuinely cheaper
 * arrangement can still drop one. `session.lockedJoinsDropped` says when that
 * happened. */
const PIN_TITLE =
  'Pin this edit: the planner strongly prefers keeping it across re-plans and re-rolls. A pin is a preference, not a guarantee — a much cheaper arrangement can still drop it.';
const UNPIN_TITLE = 'Unpin this edit.';
const PIN_LIMIT_TITLE = `Pin limit reached (${MAX_LOCKED_JOINS} pins) — unpin another edit first.`;

/** The History cost of an adjustment, stated rather than hidden (plan T15).
 * The count is CONDITIONAL: `commitPlan` pushes the marker entry only when
 * there is a marker change to record, so a zero-join arrangement or
 * `markEditPoints: false` yields exactly one entry. */
const UNDO_HINT =
  'Every adjustment is undoable: it pushes a "Remix" entry to History, plus a "Remix Markers" entry whenever the edit points change — so one adjustment is usually two Ctrl+Z presses, and one when the arrangement records no edit points.';

const LOCK_REFUSAL: Record<ToggleLockRefusal, string> = {
  'limit-reached': PIN_LIMIT_TITLE,
  stale: 'Source audio changed — adjustments unavailable.',
  'no-session': 'This remix no longer has an adjustable session.',
  'unknown-join': 'That edit is no longer part of this arrangement.',
};

const BUTTON_CLASS =
  'shrink-0 rounded px-1.5 py-0.5 text-xs text-[#8b8b92] transition-colors hover:bg-[#3a3a42] hover:text-[#d4d4d8] disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-[#8b8b92]';
const ICON_BUTTON_CLASS =
  'flex h-5 w-5 shrink-0 items-center justify-center rounded transition-colors hover:bg-[#3a3a42] hover:text-[#d4d4d8] disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent';

export default function RemixPanel() {
  // FIRST — the session store is module state, not zustand (see the doc
  // comment). Nothing below re-renders without this.
  useRemixVersion();

  const activeDocumentId = useAppStore((s) => s.activeDocumentId);
  const doc = useAppStore((s) => s.documents.find((d) => d.id === s.activeDocumentId) ?? null);
  const zoom = useAppStore((s) => s.zoom);
  const view = useAppStore((s) => s.view);
  const setCursor = useAppStore((s) => s.setCursor);
  const setZoom = useAppStore((s) => s.setZoom);
  const setView = useAppStore((s) => s.setView);

  const [busy, setBusy] = useState(false);
  const [lockNote, setLockNote] = useState<string | null>(null);
  const [crossfadeDraft, setCrossfadeDraft] = useState<number | null>(null);

  // `busyRef` gates the NEXT press synchronously — `busy` alone would let two
  // clicks in the same tick both pass the check before React re-renders.
  const busyRef = useRef(false);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // A different document is a different session: a half-dragged crossfade and
  // a refusal note from the previous one must not carry across.
  useEffect(() => {
    setCrossfadeDraft(null);
    setLockNote(null);
  }, [activeDocumentId]);

  const session = activeDocumentId ? getRemixSession(activeDocumentId) : null;

  if (!doc || !session) {
    return <div className="p-2 text-sm text-[#8b8b92]">No remix for this document.</div>;
  }

  const { plan, options, analysis, stale } = session;
  const joins = plan.joins;
  const remixDocId = session.remixDocId;
  const adjustDisabled = stale || busy;

  /** One adjustment at a time: they are async (the DP may be in the session's
   * plan worker) and they rewrite the same document, so a second press while
   * one is outstanding would race two `applyEdit`s onto the same remix. */
  const runAdjustment = async (op: () => Promise<unknown>): Promise<void> => {
    if (busyRef.current || stale) return;
    busyRef.current = true;
    setBusy(true);
    try {
      await op();
    } finally {
      busyRef.current = false;
      if (mountedRef.current) setBusy(false);
    }
  };

  // `MarkersPanel.tsx:72-85` verbatim: leave multitrack first (the cursor/zoom
  // jump is invisible there), then move the cursor and approximate centring
  // for a ~800 px viewport, which is the only width this panel can assume.
  const goTo = (positionSample: number): void => {
    if (view === 'multitrack') setView('waveform');
    setCursor(positionSample);
    const halfViewportSamples = zoom.samplesPerPixel * 400;
    setZoom({ ...zoom, scrollSample: Math.max(0, positionSample - halfViewportSamples) });
  };

  const onToggleLock = (key: string): void => {
    if (stale) return;
    const result = toggleLockJoin(remixDocId, key);
    setLockNote(result.ok ? null : LOCK_REFUSAL[result.reason]);
  };

  const crossfadeMs = crossfadeDraft ?? options.crossfadeMs;
  const commitCrossfade = (): void => {
    const value = crossfadeDraft;
    if (value === null) return;
    if (value === options.crossfadeMs) {
      setCrossfadeDraft(null);
      return;
    }
    // Render-only: `crossfadeMs` is not a replan key, so this re-renders the
    // SAME arrangement and the user's nudges survive it.
    void runAdjustment(async () => {
      await updateRemixSession(remixDocId, { crossfadeMs: value });
      if (mountedRef.current) setCrossfadeDraft(null);
    });
  };

  const lockedKeys = session.lockedJoins;
  const everyJoinPinned =
    joins.length > 0 && joins.every((j) => lockedKeys.includes(`${j.fromBar}>${j.toBar}`));
  const rerollTitle = !plan.canReroll
    ? 'This arrangement has no edits to vary.'
    : everyJoinPinned
      ? 'Every edit is pinned — unpin one to re-roll.'
      : 'Deterministic next-best arrangement for the same length.';

  const bpmLabel = analysis.bpm === null ? 'no BPM' : `${Math.round(analysis.bpm)} BPM`;
  const editCount = `${joins.length} ${joins.length === 1 ? 'edit' : 'edits'}`;
  const droppedPins = session.lockedJoinsDropped.length;

  return (
    <div data-testid="remix-panel" className="flex flex-col text-sm">
      {stale && (
        <div
          data-testid="remix-stale"
          className="border-b border-[#3a3a42] bg-[#2e2a22] px-2 py-1 text-xs text-[#ffa726]"
        >
          Source audio changed — adjustments unavailable. The remix audio is unaffected.
        </div>
      )}

      <div
        data-testid="remix-header"
        className="flex flex-col gap-1 border-b border-[#3a3a42] px-2 py-1.5"
      >
        <div className="truncate text-[#d4d4d8]">
          {doc.name} · {clock(plan.outputSample, doc.sampleRate)} (target{' '}
          {clock(options.targetSample, doc.sampleRate)})
        </div>
        <div className="truncate text-xs text-[#8b8b92]">
          {bpmLabel} · {analysis.beatsPerBar}/4 · {editCount} · from {session.sourceName}
        </div>

        <div className="flex flex-wrap items-center gap-1">
          <button
            type="button"
            title={rerollTitle}
            disabled={adjustDisabled || !plan.canReroll || everyJoinPinned}
            onClick={() => void runAdjustment(() => reRollRemix(remixDocId))}
            className={BUTTON_CLASS}
          >
            Re-roll
          </button>
          <button
            type="button"
            title="Drop every rejection, pin, nudge and re-roll and return to the automatic arrangement."
            disabled={adjustDisabled}
            onClick={() => void runAdjustment(() => resetRemix(remixDocId))}
            className={BUTTON_CLASS}
          >
            Revert to auto
          </button>
        </div>

        <label className="flex items-center gap-2 text-xs text-[#8b8b92]">
          <span className="shrink-0">Crossfade</span>
          <input
            data-testid="remix-crossfade"
            type="range"
            min={5}
            max={120}
            step={1}
            value={crossfadeMs}
            disabled={adjustDisabled}
            title="Crossfade width. Length-neutral by construction, so this re-renders the same arrangement — it never re-plans."
            onChange={(e) => setCrossfadeDraft(Number(e.target.value))}
            onMouseUp={commitCrossfade}
            onKeyUp={commitCrossfade}
            onBlur={commitCrossfade}
            className="min-w-0 flex-1"
          />
          <span className="w-12 shrink-0 text-right tabular-nums">{crossfadeMs} ms</span>
        </label>

        {droppedPins > 0 && (
          <div data-testid="remix-dropped-pins" className="text-xs text-[#ffa726]">
            {droppedPins} pinned {droppedPins === 1 ? 'edit' : 'edits'} could not be kept — a pin is
            a preference, not a guarantee.
          </div>
        )}
        {lockNote && (
          <div data-testid="remix-lock-note" className="text-xs text-[#ffa726]">
            {lockNote}
          </div>
        )}
        {busy && (
          <div data-testid="remix-busy" className="text-xs text-[#8b8b92]">
            Re-planning{session.plansInWorker ? ' in a background worker' : ''}…
          </div>
        )}
        <div data-testid="remix-undo-hint" title={UNDO_HINT} className="text-xs text-[#8b8b92]">
          Adjustments are undoable from History.
        </div>
      </div>

      {joins.length === 0 ? (
        <div className="p-2 text-sm text-[#8b8b92]">
          This arrangement plays straight through — no edits to adjust.
        </div>
      ) : (
        <ul data-testid="remix-list" className="flex flex-col py-1">
          {joins.map((join, i) => {
            const key = `${join.fromBar}>${join.toBar}`;
            // Rows follow the plan's own join order, which `renderRemix` emits
            // in ascending output-sample order — the same order the seeded
            // 'Edit k' markers are numbered in, so '#k' here and 'Edit k' in
            // the Markers panel always name the same splice.
            const atSample = session.joinSamples[i] ?? 0;
            const n = i + 1;
            const locked = lockedKeys.includes(key);
            const pinAtCap = !locked && lockedKeys.length >= MAX_LOCKED_JOINS;
            // Jumping FORWARD (toBar > fromBar) removes bars; jumping back
            // repeats them.
            const deltaBars = join.fromBar - join.toBar;
            const deltaLabel = `${deltaBars < 0 ? '−' : '+'}${Math.abs(deltaBars)} bars`;

            return (
              <li
                key={`${key}:${i}`}
                data-testid="remix-item"
                className="group flex flex-col gap-0.5 overflow-x-hidden px-2 py-1 hover:bg-[#2e2e34]"
              >
                <div className="flex min-w-0 items-center gap-1.5">
                  <span
                    data-testid="remix-quality"
                    title={costTooltip(join.cost)}
                    className={`h-2 w-2 shrink-0 rounded-full ${qualityClass(join.cost.total)}`}
                  />
                  <span className="shrink-0 tabular-nums text-[#8b8b92]">#{n}</span>
                  <button
                    type="button"
                    aria-label={`Go to edit ${n}`}
                    title="Move the cursor to this splice"
                    disabled={stale}
                    onClick={() => goTo(atSample)}
                    className="shrink-0 rounded px-1 py-0.5 text-xs tabular-nums text-[#8b8b92] transition-colors hover:bg-[#3a3a42] hover:text-[#26c6da] disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-[#8b8b92]"
                  >
                    {clock(atSample, doc.sampleRate)}
                  </button>
                  <span className="truncate text-xs text-[#d4d4d8]">
                    bar {join.fromBar} → {join.toBar}
                  </span>
                  <span className="shrink-0 text-xs tabular-nums text-[#8b8b92]">{deltaLabel}</span>
                  <span className="shrink-0 text-xs tabular-nums text-[#8b8b92]">
                    {join.cost.total.toFixed(2)}
                  </span>
                </div>

                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    aria-label={`Nudge edit ${n} earlier`}
                    title="Move this edit one bar earlier in the song — the output keeps the same number of bars."
                    disabled={adjustDisabled}
                    onClick={() => void runAdjustment(() => nudgeJoin(remixDocId, key, -1))}
                    className={`${ICON_BUTTON_CLASS} text-[#8b8b92]`}
                  >
                    <ChevronLeft size={14} />
                  </button>
                  <button
                    type="button"
                    aria-label={`Nudge edit ${n} later`}
                    title="Move this edit one bar later in the song — the output keeps the same number of bars."
                    disabled={adjustDisabled}
                    onClick={() => void runAdjustment(() => nudgeJoin(remixDocId, key, 1))}
                    className={`${ICON_BUTTON_CLASS} text-[#8b8b92]`}
                  >
                    <ChevronRight size={14} />
                  </button>
                  <button
                    type="button"
                    aria-label={locked ? `Unpin edit ${n}` : `Pin edit ${n}`}
                    title={locked ? UNPIN_TITLE : pinAtCap ? PIN_LIMIT_TITLE : PIN_TITLE}
                    aria-pressed={locked}
                    disabled={stale || pinAtCap}
                    onClick={() => onToggleLock(key)}
                    className={`${ICON_BUTTON_CLASS} ${locked ? 'text-[#26c6da]' : 'text-[#8b8b92]'}`}
                  >
                    <Pin size={13} />
                  </button>
                  <button
                    type="button"
                    aria-label={`Reject edit ${n}`}
                    title="Reject this edit: forbid it for good and re-plan another way to hit the same length."
                    disabled={adjustDisabled}
                    onClick={() => void runAdjustment(() => rejectJoin(remixDocId, key))}
                    className={`${ICON_BUTTON_CLASS} text-[#8b8b92] opacity-0 group-hover:opacity-100 disabled:opacity-40`}
                  >
                    <X size={14} />
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
