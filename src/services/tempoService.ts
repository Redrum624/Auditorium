/**
 * Feature 2 service (Task T7): change a document's BPM without changing its
 * pitch. REUSE, NOT REBUILD — the DSP itself is `timeStretchLinked`
 * (`../dsp/wsola.ts`): pitch-preserving, stereo-linked WSOLA with ONE shared
 * similarity search on the mid signal (so stereo phase stays locked) and
 * `outLen = round(N*ratio)` exactly. It is already wrapped as the
 * 'time-stretch' effect and therefore already reachable off-thread — with
 * the one-shot DSP worker, throttled progress, cancellation-safe error
 * handling and the single `applyEdit` undo path — through
 * `runEffectOnSelection` (`./effectRunner.ts`). This module is a RATIO
 * CALCULATOR plus guards on top of that existing path; it does not touch
 * the DSP.
 *
 * `tempoRatio(sourceBpm, targetBpm) = sourceBpm/targetBpm` is exactly the
 * output/input length ratio `timeStretchLinked` expects: a slower target
 * (lower BPM) makes `ratio > 1` (longer output), a faster target makes
 * `ratio < 1` (shorter output).
 *
 * `checkTempoChange` refuses a ratio outside `[MIN_RATIO, MAX_RATIO]`
 * (`wsola.ts`) rather than letting `planStretch` silently clamp it — a
 * clamped stretch would hand back audio at a DIFFERENT ratio than the one
 * requested, with nothing to signal the mismatch.
 *
 * QUALITY BANDS (surfaced verbatim by the UI, T8): +/-12% (ratio 0.88-1.14)
 * transparent; 0.5-2x good with mild transient smearing; 0.25-0.5x / 2-4x
 * extreme with audible artifacts; outside `[0.25, 4]` blocked entirely.
 * Justification: this WSOLA has 40ms analysis/synthesis frames, a 20ms
 * synthesis hop and a +/-10ms similarity search (`wsola.ts`), with NO
 * crossfade into the surrounding, un-stretched audio and NO transient
 * detection — so a selection-scoped stretch always produces a seam at both
 * edges of the region, and at the larger ratios many synthesis frames reuse
 * near-identical spans (flanging on sustained tones). Documented limitation
 * of the underlying DSP, not something this service can hide or fix.
 *
 * Optional beat markers are laid down as a SECOND, separately-labelled undo
 * step (`pushMarkerUndo`) AFTER the stretch resolves — `applyEdit`'s marker
 * remap (`editOps.ts`) can only transform EXISTING markers, never invent new
 * ones, so seeding a beat grid cannot ride inside the stretch's own entry.
 */

import type { AudioDocument } from '../audio/AudioDocument';
import { cloneRegion, docLength, mixDown } from '../audio/AudioDocument';
import type { Marker } from '../stores/appStore';
import { nextId, useAppStore } from '../stores/appStore';
import { analyzeTempo } from '../dsp/tempoCore';
import { buildTempoMap, type TempoMap } from '../dsp/tempoMap';
import { synthesisPosAt } from '../dsp/timingWarp';
import { MIN_RATIO, MAX_RATIO } from '../dsp/wsola';
import {
  MATCH_TEMPO_VARIABLE_EFFECT_ID,
  type MatchTempoVariableExtra,
} from '../effects/time/MatchTempoVariableEffect';
import { runEffectOnSelection } from './effectRunner';
import { pushMarkerUndo } from './editOps';
import { activeRegion } from './selectionRegion';

/** Why `checkTempoChange`/`applyTempoChange` refused to run.
 *
 * `'no-grid'` is R7's, and belongs only to the variable-rate path: the
 * confirmed grid holds fewer than two beats inside the region, so there is not
 * one MEASURED beat interval to follow and any map would be invention.
 *
 * `'plan-mismatch'` is R7's too, and is the only refusal reported AFTER an edit
 * has already been committed: the audio the worker returned does not have the
 * length the plan said it would, so the plan can no longer be trusted to say
 * where anything is. See {@link applyVariableTempoChange}.
 *
 * `'empty-region'` is the RESOLVED region collapsing to nothing — a selection
 * that clamps to `end <= start`, e.g. `{4000, 9000}` on a 4000-sample document
 * once {@link activeRegion} has done its work. Both chains already refuse this
 * case (`end <= start` -> `null`, test-pinned); the tempo paths did not, and
 * the constant one ran the whole way through on it: `planStretch` returned its
 * 'empty' plan, `replaceRegion` allocated fresh channels holding the same
 * samples, the `postDoc.channels !== doc.channels` gate passed on that fresh
 * allocation, and the call returned `{ok: true}` having pushed a 'Match Tempo'
 * undo entry and dirtied the document for an edit that changed nothing. The
 * guard is placed BEFORE any effect runs, so nothing is committed to refuse
 * afterwards. */
export type TempoRefusal =
  | 'no-document'
  | 'invalid-bpm'
  | 'no-op'
  | 'out-of-range'
  | 'no-grid'
  | 'empty-region'
  | 'plan-mismatch'
  /** T6-3 — the user left while the stretch was running. Distinct from the bare
   * `{ok: false}` an un-plumbed cancellation used to produce: both leave the
   * document untouched, but only one of them is something the user chose, and
   * only one of them should stay silent about it. */
  | 'cancelled';

export interface TempoChangeRequest {
  sourceBpm: number;
  targetBpm: number;
}

export interface ApplyTempoChangeRequest extends TempoChangeRequest {
  /**
   * R7 — OPT IN to the variable-rate path: correct the tempo beat by beat
   * against a CONFIRMED grid instead of applying one ratio to the whole region.
   *
   * **Absent (the default) means today's behaviour, byte for byte.** That is
   * deliberate on two counts. It keeps R7 a MINOR rather than a major, because
   * no existing caller's behaviour changes; and it is the better product
   * decision anyway — a user who reached for Match Tempo on a steady loop does
   * not want per-bar correction applied to it, and a wrong tempo map is wrong
   * differently in every bar rather than uniformly wrong, which is far harder
   * to hear and to undo.
   *
   * Positions are DOCUMENT-absolute tracked beats (`BeatGrid.beatSamples`);
   * this function converts them to region-relative itself.
   *
   * **`sourceBpm` is not read on this path at all**, and nothing validates it
   * here: {@link applyTempoChange} takes the variable branch as its FIRST
   * statement, before `checkTempoChange` runs, and
   * {@link checkVariableTempoChange} validates only `targetBpm`. So
   * `applyTempoChange({ sourceBpm: NaN, targetBpm: 110, variableRate })` warps
   * successfully, and `TempoDialog`'s follow-the-beats Apply is deliberately
   * not gated on a valid Source either. That is correct — the grid IS the
   * source tempo, per beat, so a source BPM would be a second, redundant
   * answer to a question the grid already answers — and it is stated here
   * because an earlier version of this comment claimed the opposite.
   * `sourceBpm` remains on the type only because it is inherited from
   * {@link TempoChangeRequest}, which the constant path needs.
   */
  variableRate?: {
    /** Confirmed, document-absolute beat positions, ascending. */
    beatSamples: ArrayLike<number>;
  };
  /** When true, and `firstBeatSample` is known, lays down a beat grid over
   * the stretched region as a second, separately-labelled undo step. */
  addBeatMarkers?: boolean;
  /** Sample position (PRE-stretch, in the same coordinates as the resolved
   * region) of the first beat inside the region — typically the detected
   * grid's first in-region beat. `null`/`undefined` skips beat-marker
   * creation even when `addBeatMarkers` is true. */
  firstBeatSample?: number | null;
  /**
   * T6-3 — "is this pass still wanted?", polled by the runner between the
   * stretched audio arriving and `applyEdit` writing it.
   *
   * It governs the WHOLE pass, not only the audio: this call commits up to
   * three undo entries (the stretch, the marker correction, the beat grid), and
   * every one of them after the first is synchronous with it, so one answer at
   * the one await is enough to make the pass all-or-nothing. Without it,
   * walking away mid-stretch landed all three in a document the user had left —
   * the orphaning U2's module lock was mitigating.
   *
   * Carried on the request rather than as another positional, matching
   * `runCoverJourney`, whose `shouldCancel` rides its request object for the
   * same reason: two adjacent optional callbacks transpose silently.
   */
  shouldCancel?: () => boolean;
}

export type TempoCheckResult = { ok: true; ratio: number } | { ok: false; reason: TempoRefusal };

export interface TempoChangeOutcome {
  ok: boolean;
  reason?: TempoRefusal;
}

export interface RegionTempoDetection {
  bpm: number | null;
  confidence: number;
}

/** Longest excerpt `detectRegionTempo` analyzes, regardless of selection size. */
const MAX_DETECT_SECONDS = 30;

/** Ceiling on beat markers a single `applyTempoChange` call can add — past
 * this the list is truncated and one info dialog is shown instead of
 * silently generating an unbounded marker list. */
export const MAX_BEAT_MARKERS = 512;

function activeDoc(): AudioDocument | null {
  const s = useAppStore.getState();
  return s.documents.find((d) => d.id === s.activeDocumentId) ?? null;
}

/**
 * The region every tempo operation acts on: `activeRegion` — the live selection
 * clamped into the document, or the whole document when there is none.
 *
 * ONE resolution that every path in this module reads, and that is a
 * correctness requirement rather than tidiness — the same ruling
 * `VariableTempoPlan.regionStart` records. R7 applied the clamp in
 * `checkVariableTempoChange` and left the constant path and the ratio-1 grid
 * path resolving their own `start`/`end` from the selection unclamped, which is
 * that identical defect one door along. `setSelection` stores whatever it is
 * handed, so a selection starting at −5000 gave `computeBeatMarkerPositions` a
 * NEGATIVE `newFirstBeat`, and its `Math.max(0, …)` floor then piled every early
 * beat marker onto sample 0 instead of describing beats inside the region; an
 * `end` past the document did the mirror of it, piling the late markers onto the
 * document's last sample. No UI route builds such a selection (the editor
 * gestures clamp, select-all uses `docLength`), so it was latent — but two
 * clamps that have to agree is that bug waiting to recur, and one resolved value
 * cannot drift.
 *
 * T6-1: this module WROTE that arithmetic out, and so did five others. The
 * ruling it states is now `selectionRegion.ts`, which the four call sites below
 * import; the paragraph stays because it records the defect that earned it.
 */

/** `sourceBpm/targetBpm` — the output/input length ratio `timeStretchLinked`
 * expects (a slower target makes the result longer: ratio > 1). */
export function tempoRatio(sourceBpm: number, targetBpm: number): number {
  return sourceBpm / targetBpm;
}

/**
 * Guards, evaluated in order: no active document -> 'no-document'; either
 * bpm non-finite or <= 0 -> 'invalid-bpm'; the resulting ratio within 1e-6
 * of 1.0 -> 'no-op' (never push an empty undo entry for an identical
 * tempo); ratio outside `[MIN_RATIO, MAX_RATIO]` (`wsola.ts`) ->
 * 'out-of-range' — refusing rather than relying on `planStretch`'s own
 * silent clamp, which would otherwise hand back a duration that doesn't
 * match the requested tempo.
 */
/**
 * A DELIBERATE asymmetry with the variable path, recorded rather than hidden:
 * this check is a pure ratio validator and never resolves the region, so an
 * `'empty-region'` refusal is NOT previewed here — the dialog's Apply stays
 * enabled and the constant path refuses only at {@link applyTempoChange}
 * (before any effect runs). `checkVariableTempoChange` DOES preview it,
 * because it must resolve the region to build its map anyway. The gap is
 * unreachable through the UI (gestures clamp selections and cannot produce an
 * empty resolved region on a non-empty document), so the preview would guard
 * only store-API callers, who get the same refusal one call later.
 */
export function checkTempoChange(req: TempoChangeRequest): TempoCheckResult {
  if (!activeDoc()) return { ok: false, reason: 'no-document' };

  const { sourceBpm, targetBpm } = req;
  if (!Number.isFinite(sourceBpm) || sourceBpm <= 0 || !Number.isFinite(targetBpm) || targetBpm <= 0) {
    return { ok: false, reason: 'invalid-bpm' };
  }

  const ratio = tempoRatio(sourceBpm, targetBpm);
  if (Math.abs(ratio - 1) < 1e-6) return { ok: false, reason: 'no-op' };
  if (ratio < MIN_RATIO || ratio > MAX_RATIO) return { ok: false, reason: 'out-of-range' };

  return { ok: true, ratio };
}

// ---------------------------------------------------------------------------
// R7 — the variable-rate path
// ---------------------------------------------------------------------------

/** Everything the dialog needs to describe a variable-rate match BEFORE it is
 * applied, and everything `applyTempoChange` needs to run it. Built by the
 * PURE `buildTempoMap` from the same inputs the worker will use, so the preview
 * and the run cannot disagree (F9's precedent for its clamp preview). */
export interface VariableTempoPlan {
  /** The map itself — `placed`, `clampedIndices` and the ratio extremes are
   * what the dialog reports. */
  map: TempoMap;
  /** Region-relative beats that became knots. */
  beatCount: number;
  /** How many beat intervals the ratio bound held back. Non-zero means the
   * result will not reach the target tempo everywhere, and the dialog says so
   * rather than under-delivering silently (RULING 3). */
  clampedCount: number;
  /**
   * The region's RESOLVED start, clamped into `[0, docLength]` exactly as
   * `cloneRegion` clamps it.
   *
   * Carried on the plan rather than re-resolved by each caller, and that is a
   * correctness requirement rather than tidiness: `applyVariableTempoChange`
   * used to resolve its own `start` from the selection UNCLAMPED and hand it to
   * the beat-marker writer, while this plan and `cloneRegion` both clamped. A
   * selection starting at −5000 (which `setSelection` stores verbatim) then
   * produced `realisedDelta === plannedDelta` — so the plan check passed — with
   * every early beat marker written at a NEGATIVE position. Two clamps that
   * have to agree is that bug waiting to recur; one resolved value both paths
   * read cannot drift.
   */
  regionStart: number;
  /** Region length before and after, in samples. */
  regionLength: number;
  outLength: number;
  /** The payload the effect reads off `__effectExtra`. */
  extra: MatchTempoVariableExtra;
}

export type VariableTempoCheck =
  | { ok: true; plan: VariableTempoPlan }
  | { ok: false; reason: TempoRefusal };

/** Document-absolute beats -> region-relative, keeping only those strictly
 * inside the region. A beat exactly at `end` belongs to whatever follows the
 * region, not to it. */
function regionRelativeBeats(beatSamples: ArrayLike<number>, start: number, end: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < beatSamples.length; i++) {
    const b = beatSamples[i];
    if (!Number.isFinite(b) || b < start || b >= end) continue;
    out.push(b - start);
  }
  return out;
}

/**
 * The variable-rate path's guards and plan, in one place so the dialog can
 * preview exactly what Apply will do.
 *
 * Deliberately does NOT run `checkTempoChange`'s `'no-op'` or `'out-of-range'`
 * arms:
 *
 *  - **`'no-op'` is wrong here.** Material that wobbles around 110 BPM matched
 *    to 110 BPM is the CENTRAL use of this feature, not a no-op — the whole
 *    point is that the average is already right and the individual beats are
 *    not. The constant path's `|ratio - 1| < 1e-6` guard exists because a WSOLA
 *    pass at ratio 1 would seam both region edges for zero benefit; a
 *    variable-rate pass at mean ratio 1 moves every interior beat.
 *  - **`'out-of-range'` is subsumed.** `buildTempoMap` bounds every LOCAL ratio
 *    by the same `[MIN_RATIO, MAX_RATIO]` the global guard uses, per interval
 *    rather than once for the region, and reports which intervals it held back.
 *    That is a strictly finer guard than the global one, applied where the
 *    stretch actually happens.
 */
export function checkVariableTempoChange(req: ApplyTempoChangeRequest): VariableTempoCheck {
  const doc = activeDoc();
  if (!doc) return { ok: false, reason: 'no-document' };
  if (!req.variableRate) return { ok: false, reason: 'no-grid' };
  const { targetBpm } = req;
  if (!Number.isFinite(targetBpm) || targetBpm <= 0) return { ok: false, reason: 'invalid-bpm' };

  // Clamped exactly as `cloneRegion` clamps it, so the region this plan
  // describes and the region the worker is handed cannot differ — through the
  // shared {@link activeRegion}, which is what keeps the constant path's
  // resolution from drifting away from this one again.
  const { start, end } = activeRegion(doc);
  // A resolved region that collapsed to nothing, refused by name. `buildTempoMap`
  // already refuses it — `inLen <= 0` returns its own 'empty-region' identity map,
  // which the `map.refusal` arm below turns into `'no-grid'` — so this path never
  // ran an effect on it; what this line adds is the RIGHT reason, and the same one
  // the constant path now gives, rather than blaming a grid that was fine.
  if (end <= start) return { ok: false, reason: 'empty-region' };
  const regionLength = end - start;

  const beats = regionRelativeBeats(req.variableRate.beatSamples, start, end);
  const targetSpacing = (60 / targetBpm) * doc.sampleRate;
  const map = buildTempoMap(beats, regionLength, targetSpacing);
  // Every identity outcome here is a refusal EXCEPT "the grid already matches
  // the target", which is a legitimate no-op the caller should not be charged
  // an undo entry for.
  if (map.refusal !== null) return { ok: false, reason: 'no-grid' };
  if (map.identity) return { ok: false, reason: 'no-op' };

  return {
    ok: true,
    plan: {
      map,
      beatCount: map.acceptedIndices.length,
      clampedCount: map.clampedIndices.length,
      regionStart: start,
      regionLength,
      outLength: map.outLen,
      extra: { beatSamples: beats, targetSpacing },
    },
  };
}

/** Ratio boundaries for `tempoQualityBand`, exactly as ruled in the T7 brief
 * (fix round 1, reviewer minor: exported as data rather than left as prose
 * only, so the T8 UI's copy cannot drift from this ruling). */
export const QUALITY_TRANSPARENT_MIN_RATIO = 0.88;
export const QUALITY_TRANSPARENT_MAX_RATIO = 1.14;
export const QUALITY_GOOD_MIN_RATIO = 0.5;
export const QUALITY_GOOD_MAX_RATIO = 2;

export type TempoQualityBand = 'transparent' | 'good' | 'extreme';

/**
 * Labels a (valid, already `checkTempoChange`-accepted) ratio by expected
 * audible quality: `[0.88, 1.14]` (~+/-12% BPM change) 'transparent'; the
 * rest of `[0.5, 2]` 'good' with mild transient smearing; everything else
 * inside `[MIN_RATIO, MAX_RATIO]` 'extreme', with audible artifacts. This
 * WSOLA has no crossfade into the surrounding, un-stretched audio and no
 * transient detection (`wsola.ts`), so a selection-scoped stretch always
 * produces a seam at both region edges, and at the larger ratios many
 * synthesis frames reuse near-identical spans (flanging on sustained tones)
 * — a limitation of the underlying DSP, not something this label can fix.
 */
export function tempoQualityBand(ratio: number): TempoQualityBand {
  if (ratio >= QUALITY_TRANSPARENT_MIN_RATIO && ratio <= QUALITY_TRANSPARENT_MAX_RATIO) return 'transparent';
  if (ratio >= QUALITY_GOOD_MIN_RATIO && ratio <= QUALITY_GOOD_MAX_RATIO) return 'good';
  return 'extreme';
}

/**
 * Candidate beat-marker positions inside the POST-stretch region:
 * `newFirstBeat + round(i*spacing)` while `< start + round((end-start)*ratio)`,
 * each clamped to `[0, newLen]`, capped at `MAX_BEAT_MARKERS`. Returns the
 * capped list and whether the true (uncapped) count would have exceeded it.
 *
 * `firstBeatSample` is clamped to `>= start` first (fix round 1, reviewer
 * finding): an un-clamped value below `start` maps to a negative offset,
 * which then piles multiple early candidates onto the same `Math.max(0, ...)`
 * floor instead of describing beats inside the region.
 *
 * `start`/`end` are the caller's RESOLVED region and must already be inside
 * `[0, docLength]` — {@link activeRegion} is the only thing that produces
 * them. That precondition is what the `firstBeatSample` clamp above relies on:
 * a negative `start` survives `Math.max(start, firstBeatSample)` untouched and
 * puts `newFirstBeat` below zero anyway, which is the very pile-up this clamp
 * exists to prevent, and an `end` past the document pushes `regionEnd` past
 * `newLen` so the trailing candidates collapse onto the last sample instead.
 */
function computeBeatMarkerPositions(
  start: number,
  end: number,
  ratio: number,
  targetBpm: number,
  sampleRate: number,
  firstBeatSample: number,
  newLen: number
): { positions: number[]; truncated: boolean } {
  const clampedFirstBeat = Math.max(start, firstBeatSample);
  const newFirstBeat = start + Math.round((clampedFirstBeat - start) * ratio);
  const spacing = (60 / targetBpm) * sampleRate;
  const regionEnd = start + Math.round((end - start) * ratio);

  const positions: number[] = [];
  let truncated = false;
  for (let i = 0; ; i++) {
    const pos = newFirstBeat + Math.round(i * spacing);
    if (pos >= regionEnd) break;
    if (positions.length >= MAX_BEAT_MARKERS) {
      truncated = true;
      break;
    }
    positions.push(Math.max(0, Math.min(newLen, pos)));
  }
  return { positions, truncated };
}

/** Lays down the beat grid as a separately-labelled undo step (see the module
 * doc comment for why this cannot ride inside the stretch's own `applyEdit`
 * entry). Returns `true` when it laid at least one marker, `false` when it
 * no-ops (no undo entry, no dialog) because the region yields zero beat
 * positions or the document is gone. Reached from TWO paths: AFTER a stretch
 * (ratio != 1, applyTempoChange), and — v1.9.1 item 2 — the no-stretch
 * `layBeatGridAtCurrentTempo` path at ratio 1 (`newFirstBeat === clampedFirstBeat`,
 * `regionEnd === end` by arithmetic). The boolean is what
 * `layBeatGridAtCurrentTempo` reports as success, since that path has no audio
 * edit to gate on (trap T2). */
function addBeatMarkersAfterStretch(
  docId: string,
  start: number,
  end: number,
  ratio: number,
  targetBpm: number,
  sampleRate: number,
  firstBeatSample: number
): boolean {
  const newDoc = useAppStore.getState().documents.find((d) => d.id === docId);
  if (!newDoc) return false; // document closed while the stretch was running

  const { positions, truncated } = computeBeatMarkerPositions(
    start,
    end,
    ratio,
    targetBpm,
    sampleRate,
    firstBeatSample,
    docLength(newDoc)
  );
  return writeBeatMarkers(docId, positions, truncated);
}

/**
 * R7 — the beat grid AFTER a variable-rate match, taken from the map's own
 * `placed` positions rather than re-derived from the target BPM.
 *
 * `computeBeatMarkerPositions` lays `newFirstBeat + i*spacing`, which is right
 * only when every beat got exactly the requested spacing. As soon as ONE
 * interval is clamped by the ratio bound, every beat after it carries the
 * deficit and a re-derived grid would draw markers where the audio's beats are
 * not — the "never invent a value the DSP did not produce" rule applied to
 * positions. `map.placed` is where the beats actually went.
 */
function addBeatMarkersFromMap(docId: string, start: number, map: TempoMap): boolean {
  const newDoc = useAppStore.getState().documents.find((d) => d.id === docId);
  if (!newDoc) return false; // document closed while the stretch was running

  // No clamp into `[0, docLength]`, and the reason is a precondition on
  // `start`, not a property of `placed` alone. Every placed position is inside
  // the map by construction (`placed[i] <= knotsOut[last]`, `outLen =
  // round(knotsOut[last])`), so `start + round(placed[i]) <= start + outLen` —
  // the new region's end — **provided `0 <= start <= docLength`**. That is
  // exactly what the caller now guarantees by passing `plan.regionStart`, which
  // is clamped once where the region is resolved. When this function took a
  // caller-resolved `start` instead, an unclamped negative selection wrote
  // negative marker positions straight past the check above, and a clamp here
  // hid it by silently collapsing them; the removal is only sound because the
  // precondition is now structural.
  const positions: number[] = [];
  let truncated = false;
  for (let i = 0; i < map.placed.length; i++) {
    if (positions.length >= MAX_BEAT_MARKERS) {
      truncated = true;
      break;
    }
    positions.push(start + Math.round(map.placed[i]));
  }
  return writeBeatMarkers(docId, positions, truncated);
}

/**
 * The markers the variable-rate warp displaced, put back onto the audio they
 * mark — one separately-labelled undo entry, in `'Align Markers'`'s shape.
 *
 * `applyEdit`'s shared `'stretch'` remap has already moved every interior
 * marker PROPORTIONALLY by the time this runs, and proportional is exact only
 * where the local ratio equals the region's average ratio — which for a
 * variable-rate match is true almost nowhere, since the whole point is that the
 * rate differs bar by bar. On the measured 100→120 BPM accelerando a marker
 * drifts from its audio by up to ~525 ms.
 *
 * `originals` is the marker list captured BEFORE the run, and using it is what
 * makes this a re-computation rather than an unwind: each position is sent
 * through the map the audio actually went through, exactly as
 * `timingAlignService` sends its markers through the warp map, instead of
 * trying to invert a proportional remap that has already lost information.
 * Markers the user added DURING the run have no original position and are left
 * alone; markers deleted during it simply never come back.
 *
 * Three rules, matching `remapPosition`'s own partition of the timeline:
 * before the region, untouched; inside it, `regionStart +
 * round(synthesisPosAt(map, pos - regionStart))`; at or after its end, shifted
 * by the region's length change — which is what the proportional remap already
 * did for trailing markers, so those never count as moved.
 *
 * The undo baseline is the POST-edit list, not `originals`: `applyEdit` has
 * already committed its own remap inside the stretch's entry, so undoing this
 * entry must restore what that produced, and undoing the stretch after it
 * restores the originals.
 */
function correctMarkersForWarp(docId: string, originals: Marker[], plan: VariableTempoPlan): number {
  if (originals.length === 0) return 0;

  const { map, regionStart, regionLength, outLength } = plan;
  const regionEnd = regionStart + regionLength;
  const delta = outLength - regionLength;

  const corrected = new Map<string, number>();
  for (const m of originals) {
    const pos = m.positionSample;
    if (pos < regionStart) continue; // before the region — the warp cannot touch it
    corrected.set(
      m.id,
      pos >= regionEnd
        ? pos + delta
        : regionStart + Math.round(synthesisPosAt(map, pos - regionStart))
    );
  }
  // Fast path only, and subsumed by the `moved === 0` check below — an empty
  // candidate set can never move anything. Recorded as an equivalent mutation
  // rather than left looking like a guard that nothing tests.
  if (corrected.size === 0) return 0;

  const before: Marker[] = useAppStore.getState().markers[docId] ?? [];
  let moved = 0;
  const after = before.map((m) => {
    const pos = corrected.get(m.id);
    if (pos === undefined || pos === m.positionSample) return m;
    moved++;
    return { ...m, positionSample: pos };
  });
  if (moved === 0) return 0;

  const store = useAppStore.getState();
  store.setMarkersForDoc(docId, after);
  pushMarkerUndo('Match Tempo Markers', docId, before, useAppStore.getState().markers[docId] ?? []);
  return moved;
}

/** The write half of both beat-grid paths: one combined `setMarkersForDoc`, one
 * separately-labelled undo entry, one truncation notice. Split out by R7 so the
 * constant and variable paths share the write and differ only in where the
 * positions came from. */
function writeBeatMarkers(docId: string, positions: number[], truncated: boolean): boolean {
  if (positions.length === 0) return false;

  const store = useAppStore.getState();
  const before: Marker[] = store.markers[docId] ?? [];
  // A single combined write via `setMarkersForDoc` (fix round 1, reviewer
  // finding), not up to MAX_BEAT_MARKERS sequential `addMarker` calls: each
  // `addMarker` rebuilds + sorts the WHOLE list, marks the document dirty and
  // notifies subscribers on its own — the right cost for one user action, but
  // O(n^2 log n) and n renders for a bulk write. Every other bulk marker
  // write in this repo (`fileService.ts`, `sessionFile.ts`) already uses
  // `setMarkersForDoc` for exactly this reason. `setMarkersForDoc` does not
  // itself mark the document dirty (the file-load paths share it), but this
  // path is covered twice over: the stretch's own `applyEdit` already dirtied
  // the document on the success path this function is only reached from, and
  // `pushMarkerUndo` below now stamps dirty as well (the L10 fix for marker
  // writes that arrive with no prior edit, e.g. Suggest Syllable Markers).
  const added: Marker[] = positions.map((positionSample, i) => ({
    id: nextId('marker'),
    name: `Beat ${i + 1}`,
    positionSample,
  }));
  store.setMarkersForDoc(docId, [...before, ...added]);
  const after: Marker[] = useAppStore.getState().markers[docId] ?? [];
  pushMarkerUndo('Add Beat Markers', docId, before, after);

  if (truncated) {
    void window.electronAPI?.showMessageBox({
      type: 'info',
      title: 'Beat Markers',
      message: `Only the first ${MAX_BEAT_MARKERS} beat markers were added — the stretched region contains more beats than that.`,
    });
  }
  return true;
}

/**
 * v1.9.1 item 2 — the no-stretch beat-grid path. Reached ONLY from
 * `applyTempoChange` when `checkTempoChange` refused with `'no-op'` (ratio
 * within 1e-6 of 1.0) AND the caller asked for beat markers. It resolves the
 * region exactly as `applyTempoChange` does, then lays the grid at ratio 1 —
 * `addBeatMarkersAfterStretch` is already ratio-1-safe by arithmetic
 * (`newFirstBeat === clampedFirstBeat`, `regionEnd === end`), so the grid lands
 * on the CURRENT tempo's beats. Crucially it does NOT call
 * `runEffectOnSelection`, so there is no WSOLA pass, no seam at the region
 * edges, and no stretch undo entry — only the `'Add Beat
 * Markers'` step. It deliberately does NOT copy `applyTempoChange`'s
 * `postDoc.channels !== doc.channels` success gate (trap T2): this path performs
 * no audio edit, so that identity can never change and the gate would report
 * failure after successfully writing the grid. Success is "a marker was laid",
 * which `addBeatMarkersAfterStretch` now returns.
 */
function layBeatGridAtCurrentTempo(req: ApplyTempoChangeRequest): TempoChangeOutcome {
  const doc = activeDoc();
  if (!doc) return { ok: false, reason: 'no-document' };
  if (req.firstBeatSample == null) return { ok: false, reason: 'no-op' };

  const { start, end } = activeRegion(doc);
  // Named rather than reported as a bare `{ok: false}`. This path already
  // no-ops on an empty region by arithmetic — `regionEnd === start` makes
  // `computeBeatMarkerPositions` produce no candidate, so no marker is written
  // and no undo entry is pushed — but "the grid laid nothing" and "there was no
  // region to lay it over" are different answers and the dialog shows one line.
  if (end <= start) return { ok: false, reason: 'empty-region' };

  const laid = addBeatMarkersAfterStretch(
    doc.id,
    start,
    end,
    1,
    req.targetBpm,
    doc.sampleRate,
    req.firstBeatSample
  );
  return { ok: laid };
}

/**
 * Runs `checkTempoChange`'s guards, then — if they pass — snapshots the
 * target region (selection, or the whole document, resolved exactly like
 * `runEffectOnSelection` resolves it) from LIVE state in the SAME tick, and
 * runs the existing 'time-stretch' effect over it. That single call yields,
 * for free: the one-shot DSP worker, transferred buffers, throttled
 * progress, always-settling error handling, and the undoable commit through
 * `applyEdit` with a `{type:'stretch'}` marker remap — the region is
 * TRANSFORMED, not replaced, so interior markers ride the stretch
 * proportionally (the M3 fix-round-2 ruling; `'replace'` would drop every
 * interior marker). The History label reads `Match Tempo` (v1.9.2, R2-1):
 * threaded through `runEffectOnSelection`'s `label` option — every other
 * caller omits it and keeps the default `Effect: <name>`.
 *
 * `runEffectOnSelection` never signals success/failure through its return
 * value (`Promise<void>`, always resolves) — a worker load failure, the
 * document being closed mid-run, an effect that throws, or effects simply
 * never having been registered all resolve exactly like success, having
 * shown their own error dialog. FIX ROUND 1 (reviewer finding, CRITICAL):
 * the ORIGINAL version of this function returned `{ok:true}` and (when
 * `addBeatMarkers` was set) wrote a beat grid unconditionally after that
 * `await`, regardless of whether the stretch actually applied — reachable
 * via `_setDspWorkerLoadFailure` in tests, and writing a marker grid
 * describing the REQUESTED tempo change onto audio that never changed length
 * at all, plus a spurious 'Add Beat Markers' undo entry, while reporting
 * success. `applyEdit` (`editOps.ts`) always replaces the store's document
 * OBJECT on success and is never called at all on any failure path
 * (`effectRunner.ts`'s 'error'/onerror branches return before ever calling
 * it) — so comparing the document reference before and after the `await`
 * is a real, free success signal at THIS layer, without inventing one on
 * top of the reused primitive. Both the beat-marker call and the `{ok:true}`
 * are gated on it.
 *
 * FIX ROUND 2 (reviewer finding): comparing the whole DOCUMENT reference
 * (`postDoc !== doc`) false-POSITIVES — `markDirty` (appStore.ts), and
 * therefore `addMarker`/`renameMarker`/`removeMarker`/a save-point clean,
 * all return `{...doc, dirty: true}`: a NEW document object with the SAME
 * `channels` array. Any one of those ordinary actions firing during the
 * `await` (exactly when a long stretch gives a user time to, say, drop a
 * marker at the cursor) makes `postDoc !== doc` true even though the stretch
 * itself failed, resurrecting the original corruption through a narrower
 * door. Comparing `channels` instead discriminates perfectly: `replaceRegion`
 * (`AudioDocument.ts`) unconditionally allocates a FRESH `channels` array for
 * every genuine edit — including a ratio so close to 1.0 that
 * `round(N*ratio) === N` (an identity-LENGTH edit that would false-negative
 * a `docLength` comparison, which is why that alternative was rejected) —
 * while every metadata-only replacement preserves the same `channels`
 * reference.
 */
export async function applyTempoChange(
  req: ApplyTempoChangeRequest,
  onProgress?: (fraction: number) => void
): Promise<TempoChangeOutcome> {
  // R7 — the OPT-IN variable-rate path. Taken before `checkTempoChange`
  // because that function's `'no-op'` and `'out-of-range'` arms do not apply
  // here; see `checkVariableTempoChange` for why each is wrong or subsumed. A
  // request without `variableRate` never reaches this branch, which is what
  // makes today's behaviour byte-identical for every existing caller.
  if (req.variableRate) return applyVariableTempoChange(req, onProgress);

  const check = checkTempoChange(req);
  if (!check.ok) {
    // v1.9.1 item 2 (trap T1): the 1e-6 no-op guard is CORRECT and stays — a
    // real WSOLA pass at ratio 1.0 would seam both region edges and push a
    // bogus stretch undo entry for zero tempo change. But laying
    // a beat grid AT THE CURRENT TEMPO is a distinct, legitimate action (its own
    // undo step) that must not be gated on the stretch. So a no-op ratio WITH
    // beat markers requested lays the grid and skips the stretch entirely; every
    // other refusal — including a no-op with markers OFF — is unchanged.
    if (check.reason === 'no-op' && req.addBeatMarkers && req.firstBeatSample != null) {
      return layBeatGridAtCurrentTempo(req);
    }
    return { ok: false, reason: check.reason };
  }
  const { ratio } = check;

  const doc = activeDoc();
  if (!doc) return { ok: false, reason: 'no-document' };
  const docId = doc.id;
  const sampleRate = doc.sampleRate;
  const { start, end } = activeRegion(doc);
  // BEFORE the effect, because after it there is an undo entry to un-push.
  // A region that clamps to nothing has no samples to stretch, and running
  // anyway committed a 'Match Tempo' entry over a byte-identical document: the
  // 'empty' plan returns the input unchanged, `replaceRegion` still allocates
  // fresh channel arrays, and the `postDoc.channels !== doc.channels` gate below
  // reads that fresh allocation as "applied". Same refusal both chains make.
  if (end <= start) return { ok: false, reason: 'empty-region' };

  const outcome = await runEffectOnSelection('time-stretch', { stretchPercent: ratio * 100 }, {
    onProgress,
    // v1.9.2 (R2-1): the History entry names what the user asked for — Match
    // Tempo — not the Time Stretch effect the work happens to run through.
    label: 'Match Tempo',
    shouldCancel: req.shouldCancel,
  });
  // T6-3: before the `applied` gate, which would otherwise report a cancelled
  // pass as a bare failure — and before `addBeatMarkersAfterStretch`, so a
  // cancelled pass leaves no grid over audio that was never stretched.
  if (outcome === 'cancelled') return { ok: false, reason: 'cancelled' };

  const postDoc = useAppStore.getState().documents.find((d) => d.id === docId);
  const applied = postDoc !== undefined && postDoc.channels !== doc.channels;
  if (!applied) return { ok: false };

  if (req.addBeatMarkers && req.firstBeatSample != null) {
    addBeatMarkersAfterStretch(docId, start, end, ratio, req.targetBpm, sampleRate, req.firstBeatSample);
  }

  return { ok: true };
}

/**
 * R7 — the variable-rate half of {@link applyTempoChange}.
 *
 * Structurally identical to the constant path: guards, then ONE
 * `runEffectOnSelection` call (so the one-shot DSP worker, transferred buffers,
 * throttled progress, always-settling error handling and the undoable
 * `applyEdit` commit all come for free), then the SAME `channels` identity
 * success gate — `applyEdit` always replaces the `channels` array on a genuine
 * edit and is never called at all on any failure path, while every
 * metadata-only replacement (`markDirty`, `addMarker`, …) preserves it. The
 * fix-round-2 ruling that comparing the whole document reference
 * false-POSITIVES applies here unchanged.
 *
 * The beat grid, when asked for, is laid from `plan.map.placed` — where the
 * beats actually went — not re-derived from the target BPM.
 *
 * Up to THREE undo entries per Apply, in this order: `Match Tempo` (the audio
 * plus `applyEdit`'s own proportional remap), `Match Tempo Markers` (that remap
 * corrected through the map — see {@link correctMarkersForWarp}), and
 * `Add Beat Markers`. The cost is stated rather than hidden, and stated by the
 * COUNT: with all three present, Ctrl+Z unwinds them newest first, so the first
 * removes the grid and leaves the pre-existing markers corrected, the SECOND
 * puts them transiently back at their proportional positions — the same
 * property `'Align Markers'` and `'Add Beat Markers'` already ship with — and
 * the THIRD removes the audio edit and its remap together. With no grid asked
 * for there are two entries and the sequence is one step shorter — and "up to"
 * is doing real work in both counts: `Match Tempo Markers` is pushed only when
 * a pre-existing marker actually MOVED ({@link correctMarkersForWarp} pushes
 * nothing for an empty or unmoved list — the arm `fc2a06e` pinned), so each
 * count drops by one over a marker-less region. Same counts in
 * `docs/KNOWN_LIMITATIONS.md`, which must agree with this.
 */
async function applyVariableTempoChange(
  req: ApplyTempoChangeRequest,
  onProgress?: (fraction: number) => void
): Promise<TempoChangeOutcome> {
  const check = checkVariableTempoChange(req);
  if (!check.ok) return { ok: false, reason: check.reason };

  const doc = activeDoc();
  if (!doc) return { ok: false, reason: 'no-document' };
  const docId = doc.id;
  // Captured BEFORE the run, because `applyEdit`'s proportional `'stretch'`
  // remap runs inside it and these are the positions the correction has to be
  // computed from. See {@link correctMarkersForWarp}.
  const markersBefore: Marker[] = useAppStore.getState().markers[docId] ?? [];

  const outcome = await runEffectOnSelection(
    MATCH_TEMPO_VARIABLE_EFFECT_ID,
    {},
    { onProgress, extra: check.plan.extra, label: 'Match Tempo', shouldCancel: req.shouldCancel }
  );
  // T6-3: this path's three undo entries are the reason the check has to be
  // here rather than in the dialog. `correctMarkersForWarp` and
  // `addBeatMarkersFromMap` below are synchronous with the runner's own check,
  // so one answer covers all three — but only if it is read before the first of
  // them, and a cancelled run has no stretch for either to be correct against.
  if (outcome === 'cancelled') return { ok: false, reason: 'cancelled' };

  const postDoc = useAppStore.getState().documents.find((d) => d.id === docId);
  const applied = postDoc !== undefined && postDoc.channels !== doc.channels;
  if (!applied) return { ok: false };

  // THE RUN IS CHECKED AGAINST THE PLAN IT WAS GIVEN.
  //
  // `applied` only says the channels array is a different object. It cannot
  // tell a real warp from `applyTempoMap`'s identity short circuit, which also
  // returns fresh arrays — of the SAME length. So on its own it would accept a
  // run that did nothing, report `ok: true`, and then lay a beat grid from
  // `plan.map.placed` describing positions the audio does not have.
  //
  // The realised length delta is exactly predicted — the region was replaced by
  // `plan.outLength` samples, so the document must grow by
  // `outLength - regionLength` — and the packaged smoke already treats that
  // equality as load-bearing (`lengthAfter === plannedLength`). Until now the
  // service did not, and a disagreement between the previewed map and the
  // applied one surfaced as silently misplaced markers rather than an error.
  //
  // WHAT IT DOES NOT COVER, stated rather than over-claimed: it is a check on
  // LENGTH, so it cannot see a disagreement that happens to preserve it.
  // `plannedDelta` is legitimately 0 whenever the map redistributes time
  // without changing the total — which includes the case this feature exists
  // for, material wobbling around 110 BPM matched to 110 — and there the
  // comparison degenerates to `0 === 0`.
  //
  // Two DIFFERENT things live inside that gap, and the earlier version of this
  // comment ran them together:
  //
  //  - The IDENTITY short circuit *could* be caught without the map. It returns
  //    `Float32Array.from(c)` — byte-identical copies (`tempoMap.ts`) — and the
  //    pre-edit `doc.channels` is still live here, because `replaceRegion`
  //    allocates fresh arrays for the commit rather than writing into the old
  //    ones. Comparing the returned region against the input therefore decides
  //    it exactly. It is not done because it cannot fire: `checkVariableTempoChange`
  //    already refuses `map.identity` with `'no-op'` before any run starts.
  //  - A DIFFERENT, non-identity map of equal length could not be caught that
  //    way, or by any scalar. The service holds no reference output to compare
  //    against, so seeing it would need the run's own map back from the worker.
  //
  // And the check as a whole is UNREACHABLE, not merely unexercised — no input
  // can reach it, which is a stronger statement than "no fixture has been
  // constructed". Both maps come from the same pure `buildTempoMap` on provably
  // identical arguments: `beats` and `targetSpacing` cross the worker boundary
  // as a `number[]` and a double (exact under structured clone), and the
  // worker's `inputLength` is `channels[0].length` where `channels =
  // cloneRegion(doc, start, end)` — clamped by the same `clampRange` that
  // `activeRegion` mirrors, so it equals `plan.regionLength` exactly. Both
  // store reads happen in the same synchronous tick, and the output length is
  // exactly `map.outLen` (`wsola.ts`). So `realisedDelta === plannedDelta`
  // always, including the wobble-110→110 case where both are 0 correctly.
  //
  // It STAYS because unreachable-today is a property of the current contract,
  // not an invariant: worker/service version skew, or a future divergence in
  // how the two sides resolve the region, would break it silently and this is
  // the only place that would notice. `tempoService.test.ts` pins the equal-
  // arguments property the guard actually rests on.
  const realisedDelta = docLength(postDoc) - docLength(doc);
  const plannedDelta = check.plan.outLength - check.plan.regionLength;
  if (realisedDelta !== plannedDelta) return { ok: false, reason: 'plan-mismatch' };

  // BEFORE the beat grid, so the grid appends to the corrected list rather than
  // to the proportionally-displaced one — `correctMarkersForWarp` writes the
  // whole list, so a grid laid first would be overwritten by a snapshot taken
  // before it existed.
  correctMarkersForWarp(docId, markersBefore, check.plan);

  // The PLAN's resolved start, never a freshly-resolved one — see
  // `VariableTempoPlan.regionStart`.
  if (req.addBeatMarkers) addBeatMarkersFromMap(docId, check.plan.regionStart, check.plan.map);

  return { ok: true };
}

/** The centred excerpt `detectRegionTempo` analyzes: the whole resolved
 * region when it is already `<= MAX_DETECT_SECONDS`, otherwise a centred
 * sub-window of that length clamped inside the region's own bounds. */
function centeredExcerpt(start: number, end: number, sampleRate: number): { start: number; end: number } {
  const maxLen = Math.round(MAX_DETECT_SECONDS * sampleRate);
  const regionLen = end - start;
  if (regionLen <= maxLen) return { start, end };

  const center = start + regionLen / 2;
  let s = Math.round(center - maxLen / 2);
  let e = s + maxLen;
  if (s < start) {
    s = start;
    e = s + maxLen;
  }
  if (e > end) {
    e = end;
    s = e - maxLen;
  }
  return { start: s, end: e };
}

/**
 * The 'Re-detect from selection' path: resolves the region exactly like
 * `runEffectOnSelection` does (selection ?? whole document), mixes down a
 * CENTRED excerpt capped at `MAX_DETECT_SECONDS`, and calls the pure
 * `analyzeTempo` core SYNCHRONOUSLY on the main thread — the same order of
 * cost as `captureNoiseProfile`'s synchronous STFT over an arbitrary
 * selection (`noiseProfile.ts`). Deliberately UNCACHED: writing to
 * `tempoAnalysis.ts`'s shared cache here would key it on an arbitrary region
 * instead of the whole-document analysis features 1 and 3 need.
 */
export function detectRegionTempo(): RegionTempoDetection | null {
  const doc = activeDoc();
  if (!doc) return null;

  const { start, end } = activeRegion(doc);
  const excerpt = centeredExcerpt(start, end, doc.sampleRate);

  const mono = mixDown(cloneRegion(doc, excerpt.start, excerpt.end));
  const result = analyzeTempo(mono, doc.sampleRate);
  return { bpm: result.bpm, confidence: result.confidence };
}
