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
import { MIN_RATIO, MAX_RATIO } from '../dsp/wsola';
import {
  MATCH_TEMPO_VARIABLE_EFFECT_ID,
  type MatchTempoVariableExtra,
} from '../effects/time/MatchTempoVariableEffect';
import { runEffectOnSelection } from './effectRunner';
import { pushMarkerUndo } from './editOps';

/** Why `checkTempoChange`/`applyTempoChange` refused to run.
 *
 * `'no-grid'` is R7's, and belongs only to the variable-rate path: the
 * confirmed grid holds fewer than two beats inside the region, so there is not
 * one MEASURED beat interval to follow and any map would be invention.
 *
 * `'plan-mismatch'` is R7's too, and is the only refusal reported AFTER an edit
 * has already been committed: the audio the worker returned does not have the
 * length the plan said it would, so the plan can no longer be trusted to say
 * where anything is. See {@link applyVariableTempoChange}. */
export type TempoRefusal =
  | 'no-document'
  | 'invalid-bpm'
  | 'no-op'
  | 'out-of-range'
  | 'no-grid'
  | 'plan-mismatch';

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

  // Clamped exactly as `cloneRegion` clamps it (`AudioDocument.ts`), so the
  // region this plan describes and the region the worker is handed cannot
  // differ. No store path is known that produces an out-of-bounds selection —
  // the reviewer looked and could not construct one — but the two resolutions
  // disagreeing is the ONLY route by which the previewed map and the applied
  // map could describe different audio, and matching the clamp costs nothing.
  const len = docLength(doc);
  const selection = useAppStore.getState().selection;
  const start = Math.min(Math.max(selection ? selection.start : 0, 0), len);
  const end = Math.min(Math.max(selection ? selection.end : len, 0), len);
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
  // itself mark the document dirty, but the stretch's own `applyEdit` already
  // did on the success path this function is only reached from.
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

  const selection = useAppStore.getState().selection;
  const start = selection ? selection.start : 0;
  const end = selection ? selection.end : docLength(doc);

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
  const selection = useAppStore.getState().selection;
  const start = selection ? selection.start : 0;
  const end = selection ? selection.end : docLength(doc);

  await runEffectOnSelection('time-stretch', { stretchPercent: ratio * 100 }, {
    onProgress,
    // v1.9.2 (R2-1): the History entry names what the user asked for — Match
    // Tempo — not the Time Stretch effect the work happens to run through.
    label: 'Match Tempo',
  });

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

  await runEffectOnSelection(
    MATCH_TEMPO_VARIABLE_EFFECT_ID,
    {},
    { onProgress, extra: check.plan.extra, label: 'Match Tempo' }
  );

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
  // comparison degenerates to `0 === 0` and an identity short circuit would
  // pass it. No fixture has been constructed that lands exactly on 0 after
  // rounding; this is a known gap in the check's reach, not a demonstrated
  // failure. Catching that case would need the run's own map back from the
  // worker, not a scalar.
  const realisedDelta = docLength(postDoc) - docLength(doc);
  const plannedDelta = check.plan.outLength - check.plan.regionLength;
  if (realisedDelta !== plannedDelta) return { ok: false, reason: 'plan-mismatch' };

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

  const selection = useAppStore.getState().selection;
  const start = selection ? selection.start : 0;
  const end = selection ? selection.end : docLength(doc);
  const excerpt = centeredExcerpt(start, end, doc.sampleRate);

  const mono = mixDown(cloneRegion(doc, excerpt.start, excerpt.end));
  const result = analyzeTempo(mono, doc.sampleRate);
  return { bpm: result.bpm, confidence: result.confidence };
}
