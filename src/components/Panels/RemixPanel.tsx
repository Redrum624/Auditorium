import { useEffect, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, Pin, X } from 'lucide-react';
import { useAppStore, centreEditorOn } from '../../stores/appStore';
import { formatTime } from '../../utils/timeFormat';
import {
  MAX_REQUIRED_JOINS,
  type RequiredJoinDropReason,
  type RequiredJoinsReport,
} from '../../dsp/remixPlan';
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
import { effectiveCrossfadeMs } from '../../dsp/remixRender';
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

/** `26>10` -> `bar 26 → 10`. A dropped pin's join no longer exists in the
 * plan, so it has no '#k' row number to refer to — bars are the only stable
 * name it still has, and they are the same numbers the join rows show. */
function joinLabel(key: string): string {
  const [from, to] = key.split('>');
  return `bar ${from} → ${to}`;
}

/** `m:ss` — the panel's own clock. `formatTime` always carries milliseconds,
 * which is the right resolution for a marker position and the wrong one for an
 * arrangement summary. */
function clock(sample: number, sampleRate: number): string {
  return formatTime(sample, sampleRate).replace(/\.\d+$/, '');
}

const UNPIN_TITLE = 'Unpin this edit.';
const PIN_LIMIT_TITLE = `Pin limit reached (${MAX_LOCKED_JOINS} pins) — unpin another edit first.`;

/**
 * The pin control's tooltip. A FUNCTION of BOTH the live pin count AND the
 * planner's own report on the arrangement currently on screen — never of one
 * alone, and never of a boolean reading of that report, which is three-valued
 * (`null` / `'enforced'` / `'preference'`). The phrase "strong preference"
 * appears in exactly the two states where the `remix-pins-not-guaranteed`
 * banner also appears, and the claim that every pin is enforced appears in
 * exactly the one state where the `remix-dropped-pins` note is absent. Those
 * are the invariants a property test asserts directly, over the whole
 * cross-product: banner, dropped-pins note and tooltip, one render, one answer.
 *
 * READING LESS THAN THE WHOLE REPORT WAS WRONG FIVE TIMES, each one state
 * further in:
 *
 * 1. (fix round 1, I1) A fixed "you already have more than 4 pins" was shown
 *    from `MAX_REQUIRED_JOINS` onward — it has to warn on the button that
 *    would become the fifth pin — so it was false at exactly 4, its commonest
 *    case.
 * 2. (fix round 2, I2) `toggleLockJoin` deliberately does not re-plan, so
 *    after pin 5 → Re-roll → unpin the live count is back inside the cap while
 *    the arrangement on screen is still a preference plan. A count-only
 *    tooltip then said "you have 4 pins, which is all the planner can
 *    guarantee" — implying those four ARE guaranteed — in the same render as a
 *    banner saying they are not.
 * 3. (fix round 2, found by the property test written for 2) The mirror image:
 *    triage means pins that are rejected or not a legal splice consume no
 *    guarantee slot, so SIX pins can be fully enforced. A count-only over-cap
 *    tooltip told those users their pins were "currently strong preferences"
 *    while the planner had enforced every one of them and the banner was
 *    correctly absent.
 * 4. (fix round 3) `mode === 'preference'` collapsed the report to a boolean,
 *    so `pinReport === null` — no plan has EVER been made with pins, because
 *    pinning does not re-plan — took the `else` branch and claimed the
 *    arrangement's pins were "all enforced" when the planner had never seen
 *    one of them.
 * 5. (fix round 3) "this arrangement's are all enforced" contradicted the
 *    `remix-dropped-pins` note ~100 px above it in the same header:
 *    `remixPlan.ts` keeps `mode: 'enforced'` while triage drops keys, and
 *    above the cap it MUST have dropped at least `count - MAX_REQUIRED_JOINS`
 *    of them — otherwise `feasible.length` would have exceeded the cap and the
 *    mode would be `'preference'`. So in that branch the "all enforced" claim
 *    was not merely sometimes wrong, it was never right.
 *
 * The lesson is in the shape rather than the strings: a fact the planner
 * decides must not be re-derived in the panel from a proxy, however obvious
 * the proxy looks — and a three-valued fact must not be read as two.
 *
 * `hasUnplannedPins` is the third input for the same reason: `satisfied` and
 * `dropped` together ARE the pin set the plan on screen was made with, so a
 * live pin in neither is one the planner has not seen, and nothing may be
 * claimed about its enforcement.
 */
function pinTitle(
  count: number,
  report: RequiredJoinsReport | null,
  hasUnplannedPins: boolean
): string {
  const lead = 'Pin this edit.';
  if (report?.mode === 'preference') {
    return count > MAX_REQUIRED_JOINS
      ? `${lead} You already have ${count} pins, more than the ${MAX_REQUIRED_JOINS} the planner can guarantee, so pins are currently strong preferences rather than guarantees.`
      : `${lead} This arrangement's pins are strong preferences, not guarantees — it was planned with more than ${MAX_REQUIRED_JOINS}. Re-roll to re-plan with the guarantee.`;
  }
  if (count > MAX_REQUIRED_JOINS) {
    if (report !== null && !hasUnplannedPins) {
      // Over the cap, every live pin went through the planner, and the mode is
      // still 'enforced' — which is only reachable when triage dropped enough
      // keys to bring the feasible set back under the cap. So there are always
      // drops here, they are always named in `remix-dropped-pins` above, and
      // the honest sentence is which pins were kept, not "all of them".
      return `${lead} You already have ${count} pins. Only ${MAX_REQUIRED_JOINS} can be guaranteed at once, but pins you rejected or that are not a legal splice do not use a slot — the ${report.satisfied.length} this arrangement kept are enforced, and the rest are named above. One more pin may tip it over.`;
    }
    // `pinReport === null` (nothing has been planned with pins at all) or pins
    // added since the last plan. Either way the planner has not ruled on this
    // set, so the only true statement is about the NEXT re-plan.
    return `${lead} You already have ${count} pins, more than the ${MAX_REQUIRED_JOINS} the planner can guarantee, and this arrangement was not planned with all of them. Re-roll to re-plan: pins you rejected or that are not a legal splice do not use a slot, so more than ${MAX_REQUIRED_JOINS} can sometimes still be enforced.`;
  }
  if (count === MAX_REQUIRED_JOINS) {
    return `${lead} You already have ${MAX_REQUIRED_JOINS} pins, which is all the planner can guarantee — a ${MAX_REQUIRED_JOINS + 1}th would put every pin beyond what it can enforce.`;
  }
  return `${lead} Every re-plan and re-roll will keep it — guaranteed for up to ${MAX_REQUIRED_JOINS} pins; beyond that the planner cannot enforce them all, and says so.`;
}

/** Why a specific pin could not be kept, in the user's terms. One sentence per
 * category, because the categories mean genuinely different things and "some
 * pins were dropped" tells the user nothing they can act on. */
const PIN_DROP_REASON: Record<RequiredJoinDropReason, string> = {
  forbidden: 'you rejected this edit, and a rejection wins over a pin',
  'no-candidate': 'this edit is not a legal splice for the current phrase and repeat settings',
  incompatible: 'it cannot coexist with the other pins that were kept',
  'not-enforced': `only ${MAX_REQUIRED_JOINS} pins can be guaranteed at once`,
};

/** The History cost of an adjustment, stated rather than hidden (plan T15).
 * The count is CONDITIONAL: `commitPlan` pushes the marker entry only when
 * there is a marker change to record, so a zero-join arrangement or
 * `markEditPoints: false` yields exactly one entry. */
const UNDO_HINT =
  'Every adjustment is undoable: it pushes a "Remix" entry to History, plus a "Remix Markers" entry whenever the edit points change — so one adjustment is usually two Ctrl+Z presses, and one when the arrangement records no edit points.';

/** Why the requested width can be more than the width applied — the renderer's
 * own quarter-beat clamp (`remixRender.ts`'s `effectiveCrossfadeMs`), stated
 * rather than left to be discovered. The applied figure is an upper bound per
 * join: a join against a file edge, or on a segment shorter than the fade, is
 * narrowed further by the renderer's own edge clamps. */
const CROSSFADE_CAP_TITLE =
  'A crossfade wider than a quarter of the beat period would smear across the beat, so the renderer caps it there. Individual edits at the very start or end of the source can be narrower still.';

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

  // MarkersPanel's rule, and TranscriptPanel's: leave multitrack first (the
  // cursor/zoom jump is invisible there), then move the cursor and centre. The
  // "~800 px viewport" this used to approximate is gone — `centreEditorOn`
  // reads the lane's MEASURED width, so no panel guesses it any more.
  const goTo = (positionSample: number): void => {
    if (view === 'multitrack') setView('waveform');
    setCursor(positionSample);
    // F11 fix round: one shared writer, which centres on the lane's MEASURED
    // width and clamps. The old inline version assumed a ~800px viewport and
    // wrote `setZoom` directly, so at fit — where every freshly opened document
    // now sits — it scrolled past an end the waveform could not follow.
    centreEditorOn(positionSample);
  };

  const onToggleLock = (key: string): void => {
    if (stale) return;
    const result = toggleLockJoin(remixDocId, key);
    setLockNote(result.ok ? null : LOCK_REFUSAL[result.reason]);
  };

  const crossfadeMs = crossfadeDraft ?? options.crossfadeMs;
  // Defect 4a: `renderRemix` clamps the requested width to a quarter of the
  // median beat period, so from ~125 BPM up the top of this 5-120 ms slider is
  // unreachable. The cap is deliberate (a wider crossfade smears across the
  // beat) and is NOT relaxed here — it is only made visible, from the SAME
  // function the renderer clamps with, over this session's own tracked beats.
  const appliedMs = Math.round(effectiveCrossfadeMs(crossfadeMs, analysis.beatSamples, doc.sampleRate));
  const crossfadeCapped = appliedMs < crossfadeMs;
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
  // The guarantee is only OFF when the planner says so — read from the plan's
  // own report rather than re-derived from `lockedJoins.length` here, so the
  // panel can never claim a mode the planner did not actually use (pins that
  // are rejected or illegal are triaged out first and do not count towards
  // the cap).
  //
  // But `toggleLockJoin` deliberately does NOT re-plan (pinning a join already
  // in the arrangement cannot change that arrangement, and re-rendering would
  // charge two undo entries for identical audio), so after unpinning, the mode
  // still describes the plan ON SCREEN while the pin tooltip beside it is
  // derived live from `lockedKeys.length`. Two controls stating the same fact
  // differently in one render is the defect, not the lag (fix round 1, I2).
  // Resolved by saying which is which: the banner has a second wording for
  // "you have already unpinned; the arrangement showing has not caught up",
  // so it never tells a user with 4 pins to unpin down to 4.
  const pinReport = session.pinReport;
  const pinsNotGuaranteed = pinReport?.mode === 'preference';
  const pinCountStillOverCap = lockedKeys.length > MAX_REQUIRED_JOINS;
  // The report — the planner's own verdict on the plan on screen — feeds BOTH
  // the banner and the pin tooltip (fix round 2, I2), and the tooltip gets it
  // WHOLE rather than as `pinsNotGuaranteed` (fix round 3): `null` is a third
  // value, not a quieter `'enforced'`. Neither control re-derives the verdict
  // from the pin count, which is a proxy that disagrees with it in three
  // reachable states: unpinned-but-not-yet-re-planned, over the cap but
  // rescued by triage, and pinned-but-never-planned.
  //
  // `satisfied` and `dropped` together ARE the pin set the plan on screen was
  // made with (`remixPlan.ts`'s `buildRequiredReport`), so a live pin in
  // neither is one no plan has ruled on.
  const plannedPinKeys = new Set(
    pinReport ? [...pinReport.satisfied, ...pinReport.dropped.map((d) => d.key)] : []
  );
  const hasUnplannedPins = lockedKeys.some((key) => !plannedPinKeys.has(key));
  // Name the specific edits and WHY, grouped by category — "some pins were
  // dropped" is exactly the message this task exists to replace.
  const droppedDetail = (() => {
    const drops = pinReport?.dropped ?? [];
    if (drops.length === 0) return '';
    const byReason = new Map<RequiredJoinDropReason, string[]>();
    for (const d of drops) byReason.set(d.reason, [...(byReason.get(d.reason) ?? []), joinLabel(d.key)]);
    return [...byReason.entries()]
      .map(([reason, labels]) => `${labels.join(', ')}: ${PIN_DROP_REASON[reason]}`)
      .join('; ');
  })();

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
          <span
            data-testid="remix-crossfade-readout"
            className="w-20 shrink-0 text-right tabular-nums"
          >
            {crossfadeCapped ? `${crossfadeMs} → ${appliedMs} ms` : `${crossfadeMs} ms`}
          </span>
        </label>
        {crossfadeCapped && (
          <div
            data-testid="remix-crossfade-capped"
            title={CROSSFADE_CAP_TITLE}
            className="text-xs text-[#8b8b92]"
          >
            {appliedMs} ms applied — a quarter of this track's beat period is the widest fade that
            stays inside the beat.
          </div>
        )}

        {pinsNotGuaranteed && (
          <div data-testid="remix-pins-not-guaranteed" className="text-xs text-[#ffa726]">
            {pinCountStillOverCap ? (
              <>
                More than {MAX_REQUIRED_JOINS} pins: the planner cannot guarantee them all, so it is
                treating every pin as a strong preference. Unpin down to {MAX_REQUIRED_JOINS} to get
                the guarantee back.
              </>
            ) : (
              <>
                This arrangement was planned with more than {MAX_REQUIRED_JOINS} pins, so its pins
                are strong preferences. Re-roll to re-plan with the guarantee.
              </>
            )}
          </div>
        )}
        {droppedPins > 0 && (
          <div data-testid="remix-dropped-pins" className="text-xs text-[#ffa726]">
            {droppedPins} pinned {droppedPins === 1 ? 'edit' : 'edits'} could not be kept
            {droppedDetail ? ` — ${droppedDetail}` : ''}.
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
                    // Deliberately NOT gated on `stale`. Go To mutates
                    // nothing, re-plans nothing and re-renders nothing — it
                    // moves the cursor and zoom of the REMIX document, whose
                    // audio the banner right above says is unaffected. A stale
                    // session degrades to read-only, not to inert: auditioning
                    // the splices of the remix you already have is the one
                    // thing still worth doing in that state.
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
                    title={
                      locked
                        ? UNPIN_TITLE
                        : pinAtCap
                          ? PIN_LIMIT_TITLE
                          : pinTitle(lockedKeys.length, pinReport, hasUnplannedPins)
                    }
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
